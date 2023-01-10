/* eslint-disable func-style */
/* eslint-disable require-jsdoc */
import * as path from 'path';
import {inspect} from 'util';
import type {ScheduledHandler} from 'aws-lambda';
import axios from 'axios';
import 'source-map-support/register.js';
import {db, incrementCounter, s3, uploadImage} from '../lib/aws';

const PER_PAGE = 56;
const mode = 'all';

const wait = (time: number) => new Promise((resolve) => {
	setTimeout(resolve, time);
});

interface Creator {
	creatorId: string,
}

interface CreatorResponse {
	data: {
		body: Creator[],
	},
}

interface File {
	url: string,
}

interface Image {
	originalUrl: string,
	thumbnailUrl: string,
}

interface Item {
	body: {
		images?: Image[],
		imageMap?: {
			[imageId: string]: Image,
		},
		files?: File[],
		fileMap?: {
			[fileId: string]: File,
		},
	} | null,
	id: string,
	isRestricted: boolean,
}

interface ItemsResponse {
	data: {
		body: {
			items: Item[],
			nextUrl: string,
		},
	},
}

interface ItemResponse {
	data: {
		body: Item,
	},
}

// :innocent:
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.190 Safari/537.36';

async function* iterateAllHistory(session: string) {
	console.log('starting');

	/*
	console.log('[fanbox] Getting list of followers...');
	await wait(1000);
	const {data: {body: followers}}: CreatorResponse = await axios.get('https://api.fanbox.cc/creator.listFollowing', {
		headers: {
			'User-Agent': USER_AGENT,
			Origin: 'https://www.fanbox.cc',
			Cookie: `FANBOXSESSID=${session}`,
		},
	});

	console.log(`[fanbox] Retrieved ${followers.length} folllowers.`);

	console.log('[fanbox] Getting list of supportings...');
	await wait(1000);
	const {data: {body: supportings}}: CreatorResponse = await axios.get('https://api.fanbox.cc/plan.listSupporting', {
		headers: {
			'User-Agent': USER_AGENT,
			Origin: 'https://www.fanbox.cc',
			Cookie: `FANBOXSESSID=${session}`,
		},
	});

	console.log(`[fanbox] Retrieved ${supportings.length} supportings.`);
	*/

	for (const creatorId of ['kohamina', 'mumumuseijin']) {
		console.log(`[fanbox] Getting posts from creator ${creatorId}...`);
		await wait(1000);
		const {data: {body}}: ItemsResponse = await axios.get('https://api.fanbox.cc/post.listCreator', {
			params: {
				creatorId,
				limit: PER_PAGE,
			},
			headers: {
				'User-Agent': USER_AGENT,
				Origin: 'https://www.fanbox.cc',
				Cookie: `FANBOXSESSID=${session}`,
			},
		});
		console.log(`[fanbox] Retrieved ${body.items.length} posts from creator ${creatorId}.`);

		for (const item of body.items) {
			yield item;
		}

		let nextPageUrl = body.nextUrl;
		while (nextPageUrl) {
			console.log(`[fanbox] Getting posts from creator ${creatorId}... (params = ${new URL(nextPageUrl).search})`);
			await wait(1000);
			const {data: {body: nextBody}}: ItemsResponse = await axios.get(nextPageUrl, {
				headers: {
					'User-Agent': USER_AGENT,
					Origin: 'https://www.fanbox.cc',
					Cookie: `FANBOXSESSID=${session}`,
				},
			});
			console.log(`[fanbox] Retrieved ${nextBody.items.length} posts from creator ${creatorId}.`);

			nextPageUrl = nextBody.nextUrl;
			for (const item of nextBody.items) {
				yield item;
			}
		}
	}
}

async function* iterateHome(session: string, existingIds: Map<string, boolean>) {
	console.log('[fanbox] Getting home items...');
	await wait(1000);
	const {data: {body}}: ItemsResponse = await axios.get('https://api.fanbox.cc/post.listHome', {
		params: {
			limit: PER_PAGE,
		},
		headers: {
			'User-Agent': USER_AGENT,
			Origin: 'https://www.fanbox.cc',
			Cookie: `FANBOXSESSID=${session}`,
		},
	});

	console.log(`[fanbox] Retrieved ${body.items.length} items.`);
	for (const item of body.items) {
		yield item;
	}

	let nextPageUrl = body.nextUrl;
	let page = 1;
	while (nextPageUrl) {
		page++;
		console.log(`[fanbox] Getting home items... (params = ${new URL(nextPageUrl).search})`);
		await wait(1000);
		const {data: {body: nextBody}}: ItemsResponse = await axios.get(nextPageUrl, {
			headers: {
				'User-Agent': USER_AGENT,
				Origin: 'https://www.fanbox.cc',
				Cookie: `FANBOXSESSID=${session}`,
			},
		});
		console.log(`[fanbox] Retrieved ${nextBody.items.length} items.`);

		nextPageUrl = nextBody.nextUrl;
		let hasNewItem = false;
		for (const item of nextBody.items) {
			if (!existingIds.has(item.id)) {
				hasNewItem = true;
			}
			yield item;
		}

		if (page > 3 && !hasNewItem) {
			break;
		}
	}
}

const handler: ScheduledHandler = async (_event, context) => {
	// Retrieve all existing ids of database
	let lastKey = null;
	const existingIds = new Map<string, boolean>();
	while (lastKey !== undefined) {
		await wait(5000);
		const existingEntries = await db.scan({
			TableName: 'hakataarchive-entries-fanbox',
			ProjectionExpression: 'id,isRestricted',
			ReturnConsumedCapacity: 'INDEXES',
			...(lastKey === null ? {} : {ExclusiveStartKey: lastKey}),
		}).promise();
		console.log(`[fanbox] Retrieved ${existingEntries.Items.length} existing entries (ExclusiveStartKey = ${inspect(lastKey)})`);
		console.log(`[fanbox] Consumed capacity: ${inspect(existingEntries.ConsumedCapacity)}`);

		lastKey = existingEntries.LastEvaluatedKey;

		for (const item of existingEntries.Items) {
			existingIds.set(item.id, item.isRestricted);
		}
	}

	console.log(`[fanbox] Retrieved ${existingIds.size} ids in total`);

	await s3.upload({
		Bucket: 'hakataarchive',
		Key: 'index/fanbox.json',
		Body: JSON.stringify(Array.from(existingIds.keys())),
	}).promise();
	console.log('[fanbox] Uploaded item indices into S3');

	const sessionData = await db.get({
		TableName: 'hakataarchive-sessions',
		Key: {
			id: 'fanbox',
		},
	}).promise();
	const {session} = sessionData.Item;

	console.log('[fanbox] Session ID retrieved.');

	const posts = mode === 'home' ? iterateHome(session, existingIds) : iterateAllHistory(session);
	for await (const postSummary of posts) {
		if (context.getRemainingTimeInMillis() <= 60 * 1000) {
			console.log(`[fanbox] Remaining time (${context.getRemainingTimeInMillis()}ms) is short. Giving up...`);
			// break;
		}

		if (existingIds.has(postSummary.id)) {
			const isRestricted = existingIds.get(postSummary.id);
			if (!isRestricted || postSummary.isRestricted) {
				continue;
			}
		}

		console.log(`[fanbox] Retrieving post... (id = ${postSummary.id})`);
		await wait(1000);
		const {data: {body: post}}: ItemResponse = await axios.get('https://api.fanbox.cc/post.info', {
			params: {
				postId: postSummary.id,
			},
			headers: {
				'User-Agent': USER_AGENT,
				Origin: 'https://www.fanbox.cc',
				Cookie: `FANBOXSESSID=${session}`,
			},
		});

		const images = [
			...post.body?.images ?? [],
			...Object.values(post.body?.imageMap ?? {}),
		];

		console.log(`[fanbox] Saving ${images.length} images...`);
		for (const image of images) {
			if (context.getRemainingTimeInMillis() <= 10 * 1000) {
				console.log('[fanbox] Remaining time is too short. Stopping immediately.');
				// return;
			}

			await wait(1000);
			const {data: imageData, status} = await axios.get<Buffer>(image.originalUrl, {
				responseType: 'arraybuffer',
				headers: {
					'User-Agent': USER_AGENT,
					Origin: 'https://www.fanbox.cc',
					Cookie: `FANBOXSESSID=${session}`,
				},
				validateStatus: null,
			});

			if (status === 200) {
				await uploadImage(imageData, `fanbox/${path.posix.basename(image.originalUrl)}`);
				await incrementCounter('FanboxImageSaved');
			} else if (status === 500) {
				console.log(`[fanbox] WARNING: Retrieval of image ${image.originalUrl} failed. Falling back to thumbnail image...`);

				await wait(1000);
				const {data: thumbnailImageData} = await axios.get<Buffer>(image.thumbnailUrl, {
					responseType: 'arraybuffer',
					headers: {
						'User-Agent': USER_AGENT,
						Origin: 'https://www.fanbox.cc',
						Cookie: `FANBOXSESSID=${session}`,
					},
				});

				await uploadImage(thumbnailImageData, `fanbox/${path.posix.basename(image.originalUrl)}`);
				await incrementCounter('FanboxImageSaved');
			} else {
				throw new Error(`Status code not ok: ${status}`);
			}
		}

		const files = [
			...post.body?.files ?? [],
			...Object.values(post.body?.fileMap ?? {}),
		];

		console.log(`[fanbox] Saving ${files.length} files...`);
		for (const file of files) {
			if (context.getRemainingTimeInMillis() <= 10 * 1000) {
				console.log('[fanbox] Remaining time is too short. Stopping immediately.');
				// return;
			}

			await wait(1000);
			const {data: fileData} = await axios.get<Buffer>(file.url, {
				responseType: 'arraybuffer',
				headers: {
					'User-Agent': USER_AGENT,
					Origin: 'https://www.fanbox.cc',
					Cookie: `FANBOXSESSID=${session}`,
				},
			});

			await s3.upload({
				Bucket: 'hakataarchive',
				Key: `fanbox/${path.posix.basename(file.url)}`,
				Body: fileData,
				StorageClass: 'GLACIER_IR',
			}).promise();
			await incrementCounter('FanboxFileSaved');
		}

		console.log(`[fanbox] Saving post info... (id = ${post.id})`);
		await db.put({
			TableName: 'hakataarchive-entries-fanbox',
			Item: post,
		}).promise();
	}
};

export default handler;
