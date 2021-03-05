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

// :innocent:
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.190 Safari/537.36';

const handler: ScheduledHandler = async (_event, context) => {
	const sessionData = await db.get({
		TableName: 'hakataarchive-sessions',
		Key: {
			id: 'pixiv',
		},
	}).promise();
	const {session} = sessionData.Item;

	for (const visibility of ['show', 'hide']) {
		let offset = 0;

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
					'User-Agent': USER_AGENT,
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
				break;
			}

			offset += PER_PAGE;
		}

		// oldest first
		newWorks.reverse();
		console.log(`[visibility:${visibility}] Fetched ${newWorks.length} new illusts`);

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
				Item: work,
			}).promise();
		}
	}
};

export default handler;
