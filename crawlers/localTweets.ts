/* global BigInt */

import * as path from 'path';
import axios from 'axios';
import 'source-map-support/register.js';
import { db, incrementCounter, s3, uploadImage } from '../lib/aws';
import type { ScheduledHandler } from 'aws-lambda';
import fs from 'node:fs/promises';

const wait = (time: number) => new Promise((resolve) => setTimeout(resolve, time));

interface VxtwitterApiData {
	conversationID: string,
	date: string,
	date_epoch: number,
	hasMedia: boolean,
	hashtags: string[],
	lang: string,
	likes: number,
	mediaURLs: string[],
	media_extended: {
		size: {
			height: number,
			width: number,
		},
		thumbnail_url: string,
		type: string,
		url: string,
	}[],
	replies: number,
	retweets: number,
	text: string,
	tweetID: string,
	tweetURL: string,
	user_name: string,
	user_profile_image_url: string,
	user_screen_name: string,
}

export const handler: ScheduledHandler = async () => {
	// Retrieve index/twitter.json from S3
	const existingIndex = await s3.getObject({
		Bucket: 'hakataarchive',
		Key: 'index/twitter.json',
	}).promise();

	if (!existingIndex.Body) {
		throw new Error('[twitter] Failed to retrieve existing index from S3');
	}

	const existingIds = new Set(JSON.parse(existingIndex.Body.toString()));

	console.log(`[twitter] Retrieved ${existingIds.size} ids in total`);

	const files = await fs.readdir('../../data/1243591916');
	let newTweetsCount = 0;
	for (const file of files) {
		if (!file.endsWith('.json')) {
			continue;
		}
		console.log(`Processing ${file}...`);

		const filePath = path.join('../../data/1243591916', file);
		const tweetsJson = await fs.readFile(filePath, 'utf-8');
		const tweetsData = JSON.parse(tweetsJson);

		const tweetEntries = tweetsData?.data?.user?.result?.timeline_v2?.timeline?.instructions?.find((inst: any) => inst.type === 'TimelineAddEntries')?.entries;
		if (!tweetEntries || !Array.isArray(tweetEntries)) {
			console.log(`No tweet entries found in ${file}`);
			continue;
		}

		let fileTweetsCount = 0;
		for (const entry of tweetEntries) {
			if (!entry.content || entry.content.entryType !== 'TimelineTimelineItem') {
				continue;
			}

			const tweet = entry.content.itemContent?.tweet_results?.result;
			if (!tweet || !tweet.legacy) {
				continue;
			}

			if (tweet.__typename !== 'Tweet' && tweet.__typename !== 'TweetWithVisibilityResults') {
				continue;
			}

			fileTweetsCount++;

			const tweetID = tweet.rest_id;
			if (existingIds.has(tweetID)) {
				continue;
			}

			existingIds.add(tweetID);
			newTweetsCount++;

			const targetTweet = tweet.legacy;
			const tweetMedia = (targetTweet.extended_entities && targetTweet.extended_entities.media) || []

			console.log(`Found ${tweetMedia.length} images in tweet ${tweetID}`);

			for (const medium of tweetMedia) {
				if (!medium.media_url_https) {
					throw new Error('media_url_https is missing');
				}

				const filename = path.posix.basename(medium.media_url_https);
				console.log(`Saving ${filename}...`);

				await wait(200);
				const { data: imageData, status } = await axios.get<Buffer>(medium.media_url_https, {
					params: {
						name: 'orig',
					},
					responseType: 'arraybuffer',
					validateStatus: null,
				});

				if (status !== 200) {
					console.warn(`Warn: Status code (${status}) is not healthy. Skipping...`);
					continue;
				}

				await uploadImage(imageData, `twitter/${filename}`);
				await incrementCounter('TwitterImageSaved');
			}

			await db.put({
				TableName: 'hakataarchive-entries-twitter',
				Item: targetTweet,
			}).promise();

			await incrementCounter('TweetsSaved');
		}

		console.log(`Found ${fileTweetsCount} tweets in ${file}`);

		await s3.upload({
			Bucket: 'hakataarchive',
			Key: 'index/twitter.json',
			Body: JSON.stringify(Array.from(existingIds)),
		}).promise();

		console.log('[twitter] Uploaded new item indices into S3');
	}

	console.log(`Found ${newTweetsCount} new tweets`);
};
