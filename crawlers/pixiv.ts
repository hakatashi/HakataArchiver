import * as path from 'path';
import {inspect} from 'util';
// eslint-disable-next-line no-unused-vars
import {ScheduledHandler} from 'aws-lambda';
import axios from 'axios';
import 'source-map-support/register.js';
import {db, incrementCounter, s3, uploadImage} from '../lib/aws';

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
	// Retrieve index/pixiv.json from S3
	const existingIndex = await s3.getObject({
		Bucket: 'hakataarchive',
		Key: 'index/pixiv.json',
	}).promise();

	if (!existingIndex.Body) {
		throw new Error('[pixiv] Failed to retrieve existing index from S3');
	}

	const existingIndexData = JSON.parse(existingIndex.Body.toString());
	const publicIds = new Set(existingIndexData.public);
	const privateIds = new Set(existingIndexData.private);
	const existingIds = new Set([...publicIds, ...privateIds]);

	console.log(`[pixiv] Retrieved ${existingIds.size} ids in total`);

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

			console.log(`[pixiv:${visibility}:offset=${offset}] API response with ${works.length} works`);

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
				const {data: imageData} = await axios.get<Buffer>(page.urls.original, {
					responseType: 'arraybuffer',
					headers: {
						'User-Agent': USER_AGENT,
						Referer: 'https://www.pixiv.net/',
					},
				});

				await uploadImage(imageData, `pixiv/${path.posix.basename(page.urls.original)}`);
				await incrementCounter('PixivImageSaved');
			}

			existingIds.add(work.id);

			if (visibility === 'show') {
				publicIds.add(work.id);
			} else {
				privateIds.add(work.id);
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

	await s3.upload({
		Bucket: 'hakataarchive',
		Key: 'index/pixiv.json',
		Body: JSON.stringify({public: Array.from(publicIds), private: Array.from(privateIds)}),
	}).promise();
	console.log('[pixiv] Uploaded item indices into S3');
};

export default handler;
