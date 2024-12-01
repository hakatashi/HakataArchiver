/* global BigInt */

import * as path from 'path';
import axios from 'axios';
import 'source-map-support/register.js';
import {db, incrementCounter, s3, uploadImage} from '../lib/aws';

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

const crawlTweet = async (urlString: string) => {
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

	const vxtwitterUrl = new URL(urlString);
	vxtwitterUrl.hostname = 'api.vxtwitter.com';

	const {data: tweetData, headers} = await axios.get<VxtwitterApiData>(vxtwitterUrl.toString());
	if (headers['content-type'] !== 'application/json') {
		throw new Error(`[twitter] API response has invalid content type ${headers['content-type']}`);
	}

	if (existingIds.has(tweetData.tweetID)) {
		console.log(`[twitter] ${tweetData.tweetID} is already saved`);
		return;
	}

	existingIds.add(tweetData.tweetID);

	console.log(`[twitter] Found ${tweetData.media_extended.length} images`);

	for (const medium of tweetData.media_extended) {
		const filename = path.posix.basename(medium.url);
		console.log(`Saving ${filename}...`);

		await wait(200);
		const {data: imageData} = await axios.get<Buffer>(medium.url, {
			params: {
				name: 'orig',
			},
			responseType: 'arraybuffer',
		});

		await uploadImage(imageData, `twitter/${filename}`);
		await incrementCounter('TwitterImageSaved');
	}

	await db.put({
		TableName: 'hakataarchive-entries-twitter',
		Item: {
			id_str: tweetData.tweetID,
			id: parseInt(tweetData.tweetID),
			created_at: tweetData.date,
			lang: tweetData.lang,
			entities: {
				hashtags: tweetData.hashtags.map((tag) => ({text: tag})),
				media: tweetData.media_extended.map((medium) => ({
					media_url: medium.url,
					media_url_https: medium.url,
					type: medium.type === 'image' ? 'photo' : medium.type,
					sizes: {
						large: {
							h: medium.size.height,
							resize: 'fit',
							w: medium.size.width,
						},
					},
				})),
			},
			extended_entities: {
				media: tweetData.media_extended.map((medium) => ({
					media_url: medium.url,
					media_url_https: medium.url,
					type: medium.type === 'image' ? 'photo' : medium.type,
					sizes: {
						large: {
							h: medium.size.height,
							resize: 'fit',
							w: medium.size.width,
						},
					},
				})),
			},
			favorite_count: tweetData.likes,
			retweet_count: tweetData.retweets,
			text: tweetData.text,
			user: {
				name: tweetData.user_name,
				screen_name: tweetData.user_screen_name,
				profile_image_url: tweetData.user_profile_image_url,
			},
		},
	}).promise();
	await incrementCounter('TweetsSaved');

	await s3.upload({
		Bucket: 'hakataarchive',
		Key: 'index/twitter.json',
		Body: JSON.stringify(Array.from(existingIds)),
	}).promise();

	console.log('[twitter] Uploaded new item indices into S3');
};

export default crawlTweet;
