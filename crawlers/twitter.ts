/* global BigInt */

import * as path from 'path';
import {inspect} from 'util';
// eslint-disable-next-line no-unused-vars
import {ScheduledHandler} from 'aws-lambda';
import axios from 'axios';
import 'source-map-support/register.js';
import {DOMParserImpl, NodeImpl} from 'xmldom-ts';
import * as xpath from 'xpath-ts';
import {db, incrementCounter, s3, uploadImage} from '../lib/aws';

const wait = (time: number) => new Promise((resolve) => setTimeout(resolve, time));

const handler: ScheduledHandler = async (_event, context) => {
	// Retrieve all existing ids of database
	const existingIds = new Set();
	let lastKey = null;
	while (lastKey !== undefined) {
		await wait(1000);
		const existingEntries = await db.scan({
			TableName: 'hakataarchive-entries-twitter',
			ProjectionExpression: 'id_str',
			ReturnConsumedCapacity: 'INDEXES',
			...(lastKey === null ? {} : {ExclusiveStartKey: lastKey}),
		}).promise();
		console.log(`[twitter] Retrieved ${existingEntries.Items.length} existing entries (ExclusiveStartKey = ${inspect(lastKey)})`);
		console.log(`[twitter] Consumed capacity: ${existingEntries.ConsumedCapacity.CapacityUnits}`);

		lastKey = existingEntries.LastEvaluatedKey;

		for (const item of existingEntries.Items) {
			existingIds.add(item.id_str);
		}
	}

	console.log(`[twitter] Retrieved ${existingIds.size} ids in total`);

	await s3.upload({
		Bucket: 'hakataarchive',
		Key: 'index/twitter.json',
		Body: JSON.stringify(Array.from(existingIds)),
	}).promise();
	console.log('[twitter] Uploaded item indices into S3');

	for (const screenName of ['hakatashi', 'hakatashi_A', 'hakatashi_B']) {
		let cursor: string = null;

		for (const i of Array(10).keys()) {
			await wait(200);
			console.log(`[twitter:${screenName}:page${i}] API request with cursor ${cursor}`);
			const rssResult = await axios.get(`https://nitter.hakatashi.com/${screenName}/favorites/rss`, {
				params: {
					...(cursor === null ? {} : {cursor}),
				},
			});

			if (rssResult.status !== 200) {
				throw new Error(`[twitter:${screenName}] API request failed with status ${rssResult.status}`);
			}

			cursor = rssResult.headers['min-id'];

			const doc = new DOMParserImpl().parseFromString(rssResult.data);
			const items = xpath.select('/rss/channel/item', doc);

			if (!Array.isArray(items)) {
				throw new Error(`[twitter:${screenName}] API response is not an array`);
			}

			console.log(`[twitter:${screenName}] API response with ${items.length} tweets`);

			for (const item of items) {
				const remainingTime = context.getRemainingTimeInMillis();
				if (remainingTime <= 60 * 1000) {
					console.log(`Remaining time (${remainingTime}ms) is short. Giving up...`);
					break;
				}

				const link = xpath.select1('link', item);
				const pubDate = xpath.select1('pubDate', item);
				const title = xpath.select1('title', item);
				const description = xpath.select1('description', item);
				const dcCreator = xpath.select1('dc:creator', item);

				if (
					!(link instanceof NodeImpl) ||
					!(pubDate instanceof NodeImpl) ||
					!(title instanceof NodeImpl) ||
					!(description instanceof NodeImpl) ||
					!(dcCreator instanceof NodeImpl)
				) {
					console.error(`[twitter:${screenName}] API response has invalid format`);
					continue;
				}

				const url = link.textContent;
				const createdTimeString = pubDate.textContent;
				const text = title.textContent;
				const descriptionString = description.textContent;
				const creator = dcCreator.textContent.replaceAll(/@/g, '');

				const createdTime = new Date(createdTimeString);
				const idStr = url.match(/\/status\/(?<id>\d+)/)?.groups?.id;

				if (existingIds.has(idStr)) {
					continue;
				}

				if (!idStr) {
					console.error(`[twitter:${screenName}] API response has invalid format`);
					continue;
				}

				console.log(`[twitter:${screenName}] ${createdTime} ${url} ${descriptionString}`);

				const imageUrlMatches = Array.from(descriptionString.matchAll(
					/(?<url>http:\/\/nitter\.hakatashi\.com\/pic\/[^"]+)/g,
				));

				console.log(`[twitter:${screenName}] Found ${imageUrlMatches.length} images`);

				for (const {groups: {url: imageUrl}} of imageUrlMatches) {
					const encodedFilename = path.posix.basename(imageUrl);
					const filename = decodeURIComponent(encodedFilename).split('/')[1];

					if (!filename) {
						console.error(`[twitter:${screenName}] API response has invalid format ${imageUrl}`);
						continue;
					}

					console.log(`Saving ${filename}...`);

					const origImageUrl = imageUrl
						.replace('http://', 'https://')
						.replace('/pic/', '/pic/orig/');

					await wait(200);
					const {data: imageData} = await axios.get<Buffer>(origImageUrl, {
						responseType: 'arraybuffer',
					});

					await uploadImage(imageData, `twitter/${filename}`);
					await incrementCounter('TwitterImageSaved');
				}

				await db.put({
					TableName: 'hakataarchive-entries-twitter',
					Item: {
						id_str: idStr,
						created_at: createdTime.toISOString(),
						text,
						user: {
							screen_name: creator,
						},
						nitterDescription: descriptionString,
					},
				}).promise();
				await incrementCounter('TweetsSaved');
			}
		}
	}
};

export default handler;
