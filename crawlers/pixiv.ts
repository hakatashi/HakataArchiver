import * as path from 'path';
import {PassThrough} from 'stream';
// eslint-disable-next-line no-unused-vars
import {ScheduledHandler} from 'aws-lambda';
import axios from 'axios';
import 'source-map-support/register.js';
import {db, s3} from '../lib/aws';

const PER_PAGE = 48;
const wait = (time: number) => new Promise((resolve) => setTimeout(resolve, time));

interface BookmarksResponse {
	data: {
		error: boolean,
		message: string,
		body: {
			works: {
				illustId: number,
			}[],
		},
	},
}

const handler: ScheduledHandler = async (_event, context) => {
	const sessionData = await db.get({
		TableName: 'hakataarchive-sessions',
		Key: {
			id: 'pixiv',
		},
	}).promise();
	const {session} = sessionData.Item;

	for (const visibility of ['show', 'hide']) {
		let initialOffset = 2400;
		let offset = initialOffset;

		const newWorks = [];
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
					Cookie: `PHPSESSID=${session}`,
				},
			});

			if (data.error) {
				console.error(data.message);
				continue;
			}

			const {works} = data.body;
			if (works.length === 0) {
				break;
			}

			const workIds = works.map((work) => work.illustId);

			const existingEntriesResponse = await db.batchGet({
				RequestItems: {
					'hakataarchive-entries-pixiv': {
						Keys: workIds.map((id) => ({illustId: id})),
					},
				},
			}).promise();
			const existingEntries = new Set(existingEntriesResponse.Responses['hakataarchive-entries-pixiv'].map((entry) => entry.illustId));

			for (const work of works) {
				if (!existingEntries.has(work.illustId)) {
					newWorks.push(work);
				}
			}

			if (existingEntries.size > 0) {
				if (newWorks.length === 0 && initialOffset > 0) {
					initialOffset -= 480;
					offset = initialOffset;
					continue;
				}

				break;
			}

			offset += PER_PAGE;
		}

		// oldest first
		newWorks.reverse();
		console.log(`Fetched ${newWorks.length} new illusts`);

		for (const work of newWorks) {
			const remainingTime = context.getRemainingTimeInMillis();
			if (remainingTime <= 60 * 1000) {
				console.log(`Remaining time (${remainingTime}ms) is short. Giving up...`);
				break;
			}

			console.log(`Archiving illust data ${work.illustId}...`);

			await wait(1000);
			const {data: {body: pages}} = await axios.get(`https://www.pixiv.net/ajax/illust/${work.illustId}/pages`, {
				headers: {
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

			console.log('Flushing out changes to DynamoDB...');

			await db.put({
				TableName: 'hakataarchive-entries-pixiv',
				Item: work,
			}).promise();
		}
	}
};

export default handler;
