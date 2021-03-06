import * as path from 'path';
import {inspect} from 'util';
import {PassThrough} from 'stream';
// eslint-disable-next-line no-unused-vars
import {ScheduledHandler} from 'aws-lambda';
import axios from 'axios';
import get from 'lodash/get';
import 'source-map-support/register.js';
import {db, s3} from '../lib/aws';

const PER_PAGE = 48;
const wait = (time: number) => new Promise((resolve) => setTimeout(resolve, time));

interface Work {
	id: number,
	isBookmarkable: boolean,
}

interface BookmarksResponse {
	data: {
		error: boolean,
		message: string,
		body: {
			works: Work[],
		},
	},
}

// :innocent:
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.190 Safari/537.36';

const handler: ScheduledHandler = async (_event, context) => {
	// Retrieve all existing ids of database
	let lastKey = null;
	const existingIds = new Set();
	const publicIds = new Set();
	const privateIds = new Set();
	while (lastKey !== undefined) {
		await wait(5000);
		const existingEntries = await db.scan({
			TableName: 'hakataarchive-entries-pixiv',
			ProjectionExpression: 'id,bookmarkData',
			ReturnConsumedCapacity: 'INDEXES',
			...(lastKey === null ? {} : {ExclusiveStartKey: lastKey}),
		}).promise();
		console.log(`[pixiv] Retrieved ${existingEntries.Items.length} existing entries (ExclusiveStartKey = ${inspect(lastKey)})`);
		console.log(`[pixiv] Consumed capacity: ${inspect(existingEntries.ConsumedCapacity)}`);

		lastKey = existingEntries.LastEvaluatedKey;

		for (const item of existingEntries.Items) {
			const isPrivate = get(item, ['bookmarkData', 'private'], false);
			existingIds.add(item.id);
			if (isPrivate) {
				privateIds.add(item.id);
			} else {
				publicIds.add(item.id);
			}
		}
	}

	console.log(`[pixiv] Retrieved ${existingIds.size} ids in total`);

	await s3.upload({
		Bucket: 'hakataarchive',
		Key: 'index/pixiv.json',
		Body: JSON.stringify({public: Array.from(publicIds), private: Array.from(privateIds)}),
	}).promise();
	console.log('[pixiv] Uploaded item indices into S3');

	const sessionData = await db.get({
		TableName: 'hakataarchive-sessions',
		Key: {
			id: 'pixiv',
		},
	}).promise();
	const {session} = sessionData.Item;

	console.log('[pixiv] Session ID retrieved.');

	for (const visibility of ['show', 'hide']) {
		let offset = 0;

		const newWorks: Work[] = [];
		while (true) {
			await wait(1000);
			
			const {data}: BookmarksResponse = await axios.get('https://www.pixiv.net/ajax/user/1817093/illusts/bookmarks', {
				params: {
					tag: '',
					offset,
					limit: PER_PAGE,
					rest: visibility,
				},
				headers: {
					'User-Agent': USER_AGENT,
					Cookie: `PHPSESSID=${session}`,
				},
			});

			if (data.error) {
				console.error(data.message);
				continue;
			}

			const {works} = data.body;

			console.log(`[pixiv:${visibility}:offset=${offset}] API response with ${works.length} tweets`);

			if (works.length === 0) {
				break;
			}

			const workIds = works.map((work) => work.id);

			console.log(`[pixiv:${visibility}:offset=${offset}] workIds = ${inspect(workIds)}`);

			let stop = true;
			for (const work of works) {
				if (!existingIds.has(work.id)) {
					newWorks.push(work);
					stop = false;
				}
			}

			if (offset >= 100 && stop) {
				break;
			}

			offset += PER_PAGE;
		}

		// oldest first
		newWorks.reverse();
		console.log(`[pixiv:${visibility}] Fetched ${newWorks.length} new illusts`);

		for (const work of newWorks) {
			const remainingTime = context.getRemainingTimeInMillis();
			if (remainingTime <= 60 * 1000) {
				console.log(`[pixiv] Remaining time (${remainingTime}ms) is short. Giving up...`);
				break;
			}

			if (!work.isBookmarkable) {
				console.log(`[pixiv] ${work.id} is already deleted ;( Continuing...`);
				continue;
			}

			console.log(`[pixiv] Archiving illust data ${work.id}...`);

			await wait(1000);
			const {data: {body: pages}} = await axios.get(`https://www.pixiv.net/ajax/illust/${work.id}/pages`, {
				headers: {
					'User-Agent': USER_AGENT,
					Cookie: `PHPSESSID=${session}`,
				},

			});

			for (const page of pages) {
				if (context.getRemainingTimeInMillis() <= 10 * 1000) {
					console.log('Remaining time is too short. Stopping immediately.');
					return;
				}

				await wait(1000);
				const {data: imageStream} = await axios.get(page.urls.original, {
					responseType: 'stream',
					headers: {
						'User-Agent': USER_AGENT,
						Referer: 'https://www.pixiv.net/',
					},
				});

				const passStream = new PassThrough();
				const result = s3.upload({
					Bucket: 'hakataarchive',
					Key: `pixiv/${path.posix.basename(page.urls.original)}`,
					Body: passStream,
				});

				imageStream.pipe(passStream);

				await result.promise();
			}

			await db.put({
				TableName: 'hakataarchive-entries-pixiv',
				Item: {
					...work,
					illustId: work.id,
				},
			}).promise();
		}
	}
};

export default handler;
