import path from 'path';
import qs from 'querystring';
import {inspect} from 'util';
// eslint-disable-next-line no-unused-vars
import type {ScheduledHandler} from 'aws-lambda';
import axios from 'axios';
import get from 'lodash/get';
import last from 'lodash/last';
import 'source-map-support/register.js';
import {db, s3, incrementCounter, uploadImage} from '../lib/aws';

const cheerio = require('cheerio');

const wait = (time: number) => new Promise((resolve) => setTimeout(resolve, time));

interface Work {
	id: string,
	userId: string,
	userName: string,
	userIcon: string,
	description: string,
	imageUrls: string[];
}

interface BookmarksResponse {
	data: string,
}

// :innocent:
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.190 Safari/537.36';

export const handler: ScheduledHandler = async (_event, context) => {
	// Retrieve all existing ids of database
	let lastKey = null;
	const existingIds = new Set();
	const publicIds = new Set();
	const privateIds = new Set();
	while (lastKey !== undefined) {
		await wait(5000);
		const existingEntries = await db.scan({
			TableName: 'hakataarchive-entries-poipiku',
			ProjectionExpression: 'id,bookmarkData',
			ReturnConsumedCapacity: 'INDEXES',
			...(lastKey === null ? {} : {ExclusiveStartKey: lastKey}),
		}).promise();
		console.log(`[poipiku] Retrieved ${existingEntries.Items.length} existing entries (ExclusiveStartKey = ${inspect(lastKey)})`);
		console.log(`[poipiku] Consumed capacity: ${inspect(existingEntries.ConsumedCapacity)}`);

		lastKey = existingEntries.LastEvaluatedKey;

		for (const item of existingEntries.Items) {
			const isPrivate = get(item, ['bookmarkData', 'private'], false);
			existingIds.add(item.id);
			if (isPrivate) {
				privateIds.add(item.id);
			} else {
				publicIds.add(item.id);
			}
		}
	}

	console.log(`[poipiku] Retrieved ${existingIds.size} ids in total`);

	await s3.upload({
		Bucket: 'hakataarchive',
		Key: 'index/poipiku.json',
		Body: JSON.stringify({public: Array.from(publicIds), private: Array.from(privateIds)}),
	}).promise();
	console.log('[poipiku] Uploaded item indices into S3');

	const sessionData = await db.get({
		TableName: 'hakataarchive-sessions',
		Key: {
			id: 'poipiku',
		},
	}).promise();
	const {session} = sessionData.Item;

	console.log(`[poipiku] Session ID retrieved (session = ${session}).`);

	let page = 0;

	const newWorks: Work[] = [];
	while (true) {
		await wait(1000);

		const {data}: BookmarksResponse = await axios.get('https://poipiku.com/MyHomePcV.jsp', {
			params: {
				PG: page,
			},
			headers: {
				'User-Agent': USER_AGENT,
				Cookie: `POIPIKU_LK=${session}`,
			},
			validateStatus: null,
		});

		const $ = cheerio.load(data);
		const $items = $('.IllustItem');

		console.log(`[poipiku:page=${page}] API response with ${$items.length} items`);

		const works: Work[] = [];
		$items.each(function () {
			const id = last($(this).attr('id').split('_'));
			const userId = $(this).find('.IllustItemUserThumb').attr('href').split('/')[1];
			const userName = $(this).find('.IllustItemUserName').text();
			const userIcon = $(this).find('.IllustItemUserThumb').attr('style').replace(/^.+'(.+?)'.+$/, '$1');
			const description = $(this).find('.IllustItemDesc').text();
			const thumbImageUrl = $(this).find('.IllustItemThumbImg').attr('src');

			works.push({
				id,
				userId,
				userName,
				userIcon,
				description,
				imageUrls: [new URL(thumbImageUrl, 'https://poipiku.com/MyHomePcV.jsp').toString()],
			});
		});

		if (works.length === 0) {
			break;
		}

		const workIds = works.map((work) => work.id);

		console.log(`[poipiku:page=${page}] workIds = ${inspect(workIds)}`);

		let stop = true;
		for (const work of works) {
			if (!existingIds.has(work.id)) {
				newWorks.push(work);
				stop = false;
			}
		}

		if (stop || workIds.length === 0) {
			break;
		}

		page++;
	}

	// oldest first
	newWorks.reverse();
	console.log(`[poipiku] Fetched ${newWorks.length} new items`);

	for (const work of newWorks) {
		const remainingTime = context.getRemainingTimeInMillis();
		if (remainingTime <= 60 * 1000) {
			// console.log(`[poipiku] Remaining time (${remainingTime}ms) is short. Giving up...`);
			// break;
		}

		console.log(`[poipiku] Retrieving appended data of id=${work.id}...`);
		console.log(qs.stringify({UID: work.userId, IID: work.id}));


		await wait(1000);
		const {data, status} = await axios({
			url: 'https://poipiku.com/f/ShowAppendFileF.jsp',
			method: 'post',
			headers: {
				'User-Agent': USER_AGENT,
				'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
				Cookie: `POIPIKU_LK=${session}`,
				Referer: `https://poipiku.com/${work.userId}/${work.id}.html`,
			},
			data: qs.stringify({
				UID: work.userId,
				IID: work.id,
			}),
			validateStatus: null,
		});

		if (status !== 200) {
			console.log(`Warn: Status code (${status}) is not healthy. Aborting...`);
			continue;
		}

		const $ = cheerio.load(data.html);
		$('img').each(function () {
			work.imageUrls.push(
				new URL($(this).attr('src'), 'https://poipiku.com/MyHomePcV.jsp').toString(),
			);
		});

		let isError = false;
		for (const imageUrl of work.imageUrls) {
			if (context.getRemainingTimeInMillis() <= 10 * 1000) {
				// console.log('Remaining time is too short. Stopping immediately.');
				// return;
			}

			const fetchUrl = imageUrl.replace(/_640\.jpg$/, '');

			await wait(1000);
			const {data: imageData, status} = await axios.get<Buffer>(fetchUrl, {
				responseType: 'arraybuffer',
				headers: {
					'User-Agent': USER_AGENT,
					Referer: 'https://www.poipiku.net/',
				},
				validateStatus: null,
			});

			if (status !== 200) {
				console.log(`Warn: Status code (${status}) is not healthy. Aborting...`);
				isError = true;
				continue;
			}

			await uploadImage(imageData, `poipiku/${path.posix.basename(fetchUrl)}`);
			await incrementCounter('PoipikuImageSaved');
		}

		if (isError) {
			continue;
		}

		await db.put({
			TableName: 'hakataarchive-entries-poipiku',
			Item: work,
		}).promise();
	}
};
