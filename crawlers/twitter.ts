/* global BigInt */

import * as path from 'path';
import * as qs from 'querystring';
import {PassThrough} from 'stream';
// eslint-disable-next-line no-unused-vars
import {inspect} from 'util';
import {ScheduledHandler} from 'aws-lambda';
import axios from 'axios';
import {OAuth} from 'oauth';
import 'source-map-support/register.js';
import {db, s3} from '../lib/aws';

const wait = (time: number) => new Promise((resolve) => setTimeout(resolve, time));

const handler: ScheduledHandler = async (_event, context) => {
	// Retrieve all existing ids of database
	let lastKey = null;
	const existingIds = new Set();
	while (lastKey !== undefined) {
		await wait(5000);
		const existingEntries = await db.scan({
			TableName: 'hakataarchive-entries-twitter',
			ProjectionExpression: 'id_str',
			ReturnConsumedCapacity: 'INDEXES',
			...(lastKey === null ? {} : {ExclusiveStartKey: lastKey}),
		}).promise();
		console.log(`Retrieved ${existingEntries.Items.length} existing entries (ExclusiveStartKey = ${inspect(lastKey)})`);
		console.log(`Consumed capacity: ${inspect(existingEntries.ConsumedCapacity)}`);

		lastKey = existingEntries.LastEvaluatedKey;

		for (const item of existingEntries.Items) {
			existingIds.add(item.id_str);
		}
	}

	console.log(`Retrieved ${existingIds.size} ids in total`);

	await s3.upload({
		Bucket: 'hakataarchive',
		Key: 'index/twitter.json',
		Body: JSON.stringify(Array.from(existingIds)),
	}).promise();
	console.log('Uploaded item indices into S3');

	for (const screenName of ['hakatashi', 'hakatashi_A', 'hakatashi_B']) {
		const {Item: keys} = await db.get({
			TableName: 'hakataarchive-sessions',
			Key: {
				id: `twitter:${screenName}`,
			},
		}).promise();

		const oauth = new OAuth(
			'https://api.twitter.com/oauth/request_token',
			'https://api.twitter.com/oauth/access_token',
			keys.consumerKey,
			keys.consumerSecret,
			'1.0A',
			null,
			'HMAC-SHA1',
		);

		const api = (target: string, params: object) => (
			new Promise<any>((resolve, reject) => {
				oauth.get(
					`https://api.twitter.com/1.1/${target}.json?${qs.stringify(params)}`,
					keys.accessToken,
					keys.accessTokenSecret,
					(error, d) => {
						if (error) {
							reject(error);
						} else {
							resolve(JSON.parse(d.toString()));
						}
					},
				);
			})
		);

		const newTweets = [];
		let maxId: BigInt = null;

		for (const i of Array(10).keys()) {
			const tweets = await api('favorites/list', {
				screen_name: screenName,
				count: 200,
				include_entities: true,
				...(maxId === null ? {} : {max_id: maxId.toString()}),
			});

			console.log(`[twitter:${screenName}:page${i}] API response with ${tweets.length} tweets`);
			if (tweets.length === 0) {
				break;
			}

			for (const tweet of tweets) {
				if (!existingIds.has(tweet.id_str)) {
					newTweets.push(tweet);
				}
				maxId = BigInt(tweet.id_str) - 1n;
			}
		}

		// oldest first
		newTweets.reverse();
		console.log(`[twitter:${screenName}] Fetched ${newTweets.length} new tweets`);
		const crawledTweets = new Set();

		for (const tweet of newTweets) {
			const remainingTime = context.getRemainingTimeInMillis();
			if (remainingTime <= 60 * 1000) {
				console.log(`Remaining time (${remainingTime}ms) is short. Giving up...`);
				break;
			}

			const targetTweets = [tweet];

			let currentTweet = tweet;
			while (currentTweet.in_reply_to_status_id_str) {
				if (crawledTweets.has(currentTweet.in_reply_to_status_id_str)) {
					break;
				}

				await wait(200);
				currentTweet = await api('statuses/show', {
					id: currentTweet.in_reply_to_status_id_str,
				}).catch(() => null);

				if (currentTweet === null) {
					break;
				}

				targetTweets.push(currentTweet);
			}

			console.log(`[id:${tweet.id_str}] Retrieved ${targetTweets.length} target tweets`);

			for (const targetTweet of targetTweets) {
				for (const medium of ((targetTweet.extended_entities && targetTweet.extended_entities.media) || [])) {
					const filename = path.posix.basename(medium.media_url_https);
					console.log(`Saving ${filename}...`);

					await wait(200);
					const {data: imageStream} = await axios.get(medium.media_url_https, {
						params: {
							name: 'orig',
						},
						responseType: 'stream',
					});

					const passStream = new PassThrough();
					const result = s3.upload({
						Bucket: 'hakataarchive',
						Key: `twitter/${filename}`,
						Body: passStream,
					});

					imageStream.pipe(passStream);

					await result.promise();
				}

				crawledTweets.add(targetTweet.id_str);
				await db.put({
					TableName: 'hakataarchive-entries-twitter',
					Item: targetTweet,
				}).promise();
			}
		}
	}
};

export default handler;
