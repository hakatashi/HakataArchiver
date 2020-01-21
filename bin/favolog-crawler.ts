import * as path from 'path';
import * as qs from 'querystring';
import {PassThrough} from 'stream';
import {DynamoDB, S3} from 'aws-sdk';
import axios from 'axios';
import * as dotenv from 'dotenv';
import {OAuth} from 'oauth';
import * as scrapeIt from 'scrape-it';

dotenv.config({path: `${__dirname}/.env`});

const keys = {
	consumerKey: process.env.TWITTER_CONSUMER_KEY,
	consumerSecret: process.env.TWITTER_CONSUMER_SECRET,
	accessToken: process.env.TWITTER_ACCESS_TOKEN,
	accessTokenSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
};

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

export const db = new DynamoDB.DocumentClient({
	convertEmptyValues: true,
	region: 'ap-northeast-1',
});
export const s3 = new S3({
	region: 'ap-northeast-1',
});

const wait = (time: number) => new Promise((resolve) => setTimeout(resolve, time));
const crawledTweets = new Set();

(async () => {
	let page = 7;
	const updates: DynamoDB.DocumentClient.WriteRequests = [];

	while (true) {
		await wait(1000);
		const {data} = await axios.get(`https://favolog.org/hakatashi/${page}`, {
			headers: {
				Cookie: `_session_id=${process.env.SESSION_ID}`,
			},
		});

		const {tweets} = scrapeIt.scrapeHTML(data.toString(), {
			tweets: {
				listItem: '.tl-tweet',
				data: {
					id: {
						attr: 'id',
					},
				},
			},
		});

		if (tweets.length === 0) {
			break;
		}

		console.log(`Retrieved ${tweets.length} tweets (page = ${page})`);

		for (const tweet of tweets) {
			const id = tweet.id.replace(/^tw/, '');
			if (crawledTweets.has(id)) {
				continue;
			}

			console.log(`Retrieving tweet data (id = ${id})`);

			await wait(1000);
			const tweetData = await api('statuses/show', {id}).catch(() => null);
			if (tweetData === null) {
				console.log('Not found. Skipping...');
				continue;
			}

			const targetTweets = [tweetData];

			let currentTweet = tweetData;
			while (currentTweet.in_reply_to_status_id_str) {
				if (crawledTweets.has(currentTweet.in_reply_to_status_id_str)) {
					break;
				}

				await wait(1000);
				currentTweet = await api('statuses/show', {
					id: currentTweet.in_reply_to_status_id_str,
				}).catch(() => null);
				if (currentTweet === null) {
					break;
				}
				targetTweets.push(currentTweet);
			}

			console.log(`Retrieved ${targetTweets.length} target tweets`);

			for (const targetTweet of targetTweets) {
				for (const medium of ((targetTweet.extended_entities && targetTweet.extended_entities.media) || [])) {
					const filename = path.posix.basename(medium.media_url_https);
					console.log(`Saving ${filename}...`);

					await wait(1000);
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
				updates.push({
					PutRequest: {
						Item: targetTweet,
					},
				});

				if (updates.length >= 5) {
					console.log('Flushing out...');
					await db.batchWrite({
						RequestItems: {
							'hakataarchive-entries-twitter': updates,
						},
					}).promise();
					updates.splice(0, updates.length);
				}
			}
		}

		page++;
	}

	if (updates.length > 0) {
		await db.batchWrite({
			RequestItems: {
				'hakataarchive-entries-twitter': updates,
			},
		}).promise();
		updates.splice(0, updates.length);
	}
})();
