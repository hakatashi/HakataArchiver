import * as path from 'path';
import {inspect} from 'util';
import type {ScheduledHandler} from 'aws-lambda';
import axios from 'axios';
import 'source-map-support/register.js';
import {db, incrementCounter, s3, uploadImage} from '../lib/aws';

const PER_PAGE = 56;
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
	} | null,
	id: string,
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

// eslint-disable-next-line func-style, require-jsdoc
async function* iterateAllHistory(session: string) {
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

	for (const creator of [...followers, ...supportings]) {
		console.log(`[fanbox] Getting posts from creator ${creator.creatorId}...`);
		await wait(1000);
		const {data: {body}}: ItemsResponse = await axios.get('https://api.fanbox.cc/post.listCreator', {
			params: {
				creatorId: creator.creatorId,
				limit: PER_PAGE,
			},
			headers: {
				'User-Agent': USER_AGENT,
				Origin: 'https://www.fanbox.cc',
				Cookie: `FANBOXSESSID=${session}`,
			},
		});

		for (const item of body.items) {
			yield item;
		}

		let nextPageUrl = body.nextUrl;
		while (nextPageUrl) {
			console.log(`[fanbox] Getting posts from creator ${creator.creatorId}... (params = ${new URL(nextPageUrl).search})`);
			await wait(1000);
			const {data: {body: nextBody}}: ItemsResponse = await axios.get(nextPageUrl, {
				headers: {
					'User-Agent': USER_AGENT,
					Origin: 'https://www.fanbox.cc',
					Cookie: `FANBOXSESSID=${session}`,
				},
			});
			console.log(`[fanbox] Retrieved ${nextBody.items.length} posts from creator ${creator.creatorId}.`);

			nextPageUrl = nextBody.nextUrl;
			for (const item of nextBody.items) {
				yield item;
			}
		}
	}
}

// eslint-disable-next-line no-unused-vars
const handler: ScheduledHandler = async (_event, _context) => {
	// Retrieve all existing ids of database
	let lastKey = null;
	const existingIds = new Set();
	while (lastKey !== undefined) {
		await wait(5000);
		const existingEntries = await db.scan({
			TableName: 'hakataarchive-entries-fanbox',
			ProjectionExpression: 'id',
			ReturnConsumedCapacity: 'INDEXES',
			...(lastKey === null ? {} : {ExclusiveStartKey: lastKey}),
		}).promise();
		console.log(`[fanbox] Retrieved ${existingEntries.Items.length} existing entries (ExclusiveStartKey = ${inspect(lastKey)})`);
		console.log(`[fanbox] Consumed capacity: ${inspect(existingEntries.ConsumedCapacity)}`);

		lastKey = existingEntries.LastEvaluatedKey;

		for (const item of existingEntries.Items) {
			existingIds.add(item.id);
		}
	}

	console.log(`[fanbox] Retrieved ${existingIds.size} ids in total`);

	await s3.upload({
		Bucket: 'hakataarchive',
		Key: 'index/fanbox.json',
		Body: JSON.stringify(Array.from(existingIds)),
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

	for await (const postSummary of iterateAllHistory(session)) {
		if (existingIds.has(postSummary.id)) {
			continue;
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

		console.log(`[fanbox] Saving post info... (id = ${post.id})`);
		await db.put({
			TableName: 'hakataarchive-entries-fanbox',
			Item: post,
		}).promise();
	}
};

export default handler;
