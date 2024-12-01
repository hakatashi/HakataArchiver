/* eslint-disable func-style */
/* eslint-disable require-jsdoc */
import * as path from 'path';
import {inspect} from 'util';
import type {ScheduledHandler} from 'aws-lambda';
import axios from 'axios';
import 'source-map-support/register.js';
import {chunk, groupBy} from 'lodash';
import {db, incrementCounter, s3, uploadImage} from '../lib/aws';

const PER_PAGE = 56;
const mode = 'home';

const wait = (time: number) => new Promise((resolve) => {
	setTimeout(resolve, time);
});

interface StringSet {
	values: string[],
}

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
	creatorId: string,
}

interface CreatorsItem {
	creatorId: string,
	postIds?: StringSet,
	savedPostIds?: StringSet,
}

interface ItemsResponse {
	data: {
		body: Item[],
	},
}

interface ItemResponse {
	data: {
		body: Item,
	},
}

interface PaginateCreatorResponse {
	data: {
		body: string[],
	},
}

// :innocent:
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.190 Safari/537.36';

async function* iterateAllHistory(session: string) {
	console.log(`[fanbox] Getting list of followers... (session = ${session})`);
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
		console.log(`[fanbox] Generating pagination URLs of creator ${creator}...`);

		await wait(1000);
		const {data: {body: pagenationUrls}}: PaginateCreatorResponse = await axios.get('https://api.fanbox.cc/post.paginateCreator', {
			params: {
				creatorId: creator,
			},
			headers: {
				'User-Agent': USER_AGENT,
				Origin: 'https://www.fanbox.cc',
				Cookie: `FANBOXSESSID=${session}`,
			},
		});

		console.log(`[fanbox] Getting posts from creator ${creator}...`);

		for (const url of pagenationUrls) {
			console.log(`[fanbox] Getting posts from creator ${creator}... (url = ${url})`);

			await wait(1000);
			const {data: {body: items}}: ItemsResponse = await axios.get(url, {
				headers: {
					'User-Agent': USER_AGENT,
					Origin: 'https://www.fanbox.cc',
					Cookie: `FANBOXSESSID=${session}`,
				},
			});
			console.log(`[fanbox] Retrieved ${items.length} posts from creator ${creator}.`);

			for (const item of items) {
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
			TableName: 'hakataarchive-entries-fanbox-creators',
			ProjectionExpression: 'creatorId,postIds,savedPostIds',
			ReturnConsumedCapacity: 'INDEXES',
			...(lastKey === null ? {} : {ExclusiveStartKey: lastKey}),
		}).promise();

		const items = existingEntries.Items as CreatorsItem[];
		console.log(`[fanbox] Retrieved ${items.length} existing entries (ExclusiveStartKey = ${inspect(lastKey)})`);
		console.log(`[fanbox] Consumed capacity: ${inspect(existingEntries.ConsumedCapacity)}`);

		lastKey = existingEntries.LastEvaluatedKey;

		for (const item of items) {
			const savedPostIds = new Set(item.savedPostIds?.values ?? []);
			for (const postId of item.postIds?.values ?? []) {
				existingIds.set(postId, !savedPostIds.has(postId));
			}
		}
	}

	if (false) {
		const entriesByCreatorId = Object.entries(groupBy(entries, (entry) => entry.creatorId));
		for (const entriesChunk of chunk(entriesByCreatorId, 25)) {
			console.log('[fanbox] Updating creators table.');
			console.log(inspect(entriesChunk, {depth: null, maxArrayLength: null}));
			const result = await db.batchWrite({
				RequestItems: {
					'hakataarchive-entries-fanbox-creators': entriesChunk.map(([creatorId, creatorEntries]) => {
						const postIds = creatorEntries.map((entry) => entry.id);
						const savedPostIds =
									creatorEntries
										.filter((entry) => entry.isRestricted === false)
										.map((entry) => entry.id);
						return {
							PutRequest: {
								Item: {
									creatorId,
									...(postIds.length > 0 ? {postIds: db.createSet(postIds)} : {}),
									...(savedPostIds.length > 0 ? {savedPostIds: db.createSet(savedPostIds)} : {}),
								},
							},
						};
					}),
				},
			}).promise();
			console.log(`[fanbox] Unprocessed items size: ${result.UnprocessedItems.length}`);
			console.log(`[fanbox] Consumed capacity: ${inspect(result.ConsumedCapacity)}`);
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
			break;
		}

		if (existingIds.has(postSummary.id)) {
			const isRestricted = existingIds.get(postSummary.id);
			if (!isRestricted || postSummary.isRestricted) {
				console.log(`[fanbox] Skipping post... (id = ${postSummary.id})`);
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
				return;
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
				return;
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

		await db.update({
			TableName: 'hakataarchive-entries-fanbox-creators',
			Key: {
				creatorId: post.creatorId,
			},
			...(post.isRestricted ? {
				UpdateExpression: 'ADD postIds :postIds',
				ExpressionAttributeValues: {
					':postIds': db.createSet([post.id]),
				},
			} : {
				UpdateExpression: 'ADD savedPostIds :savedPostIds, postIds :postIds',
				ExpressionAttributeValues: {
					':savedPostIds': db.createSet([post.id]),
					':postIds': db.createSet([post.id]),
				},
			}),
			ReturnValues: 'UPDATED_NEW',
		}).promise();
	}
};

export default handler;
