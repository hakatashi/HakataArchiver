/* eslint-disable import/prefer-default-export */

import path from 'path';
import {PassThrough} from 'stream';
// eslint-disable-next-line no-unused-vars
import {APIGatewayProxyHandler} from 'aws-lambda';
import 'source-map-support/register.js';
import {DynamoDB, S3} from 'aws-sdk';
import axios from 'axios';

const db = new DynamoDB.DocumentClient({convertEmptyValues: true});
const s3 = new S3();

const PER_PAGE = 48;

const wait = (time: number) => new Promise((resolve) => setTimeout(resolve, time));

export const crawlPixiv: APIGatewayProxyHandler = async () => {
	const sessionData = await db.get({
		TableName: 'hakataarchive-sessions',
		Key: {
			id: 'pixiv',
		},
	}).promise();
	const {session} = sessionData.Item;

	for (const visibility of ['show', 'hide']) {
		let offset = 2400;

		const newWorks = [];
		while (true) {
			await wait(1000);
			const {data} = await axios.get('https://www.pixiv.net/ajax/user/1817093/illusts/bookmarks', {
				params: {
					tag: '',
					offset,
					limit: PER_PAGE,
					rest: visibility,
				},
				headers: {
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
		console.log(`Fetched ${newWorks.length} new illusts`);

		const updates = [];
		for (const work of newWorks) {
			console.log(`Archiving illust data ${work.illustId}...`);

			await wait(1000);
			const {data: {body: pages}} = await axios.get(`https://www.pixiv.net/ajax/illust/${work.illustId}/pages`, {
				headers: {
					Cookie: `PHPSESSID=${session}`,
				},
			});

			for (const page of pages) {
				await wait(1000);
				const {data: imageStream} = await axios.get(page.urls.original, {
					responseType: 'stream',
					headers: {
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

			updates.push({
				PutRequest: {
					Item: work,
				},
			});

			if (updates.length === 25) {
				console.log('Flushing out changes to DynamoDB...');

				await db.batchWrite({
					RequestItems: {
						'hakataarchive-entries-pixiv': updates,
					},
				}).promise();

				// empty array
				updates.splice(0, updates.length);
			}
		}

		if (updates.length > 0) {
			console.log('Flushing out changes to DynamoDB...');

			await db.batchWrite({
				RequestItems: {
					'hakataarchive-entries-pixiv': updates,
				},
			}).promise();
		}
	}

	return {
		statusCode: 200,
		body: 'ok',
	};
};

export const postSession: APIGatewayProxyHandler = async (event) => {
	const body = JSON.parse(event.body);

	if (typeof body.apikey !== 'string' || body.apikey !== process.env.HAKATASHI_API_KEY) {
		return {
			statusCode: 403,
			body: 'apikey is missing or wrong',
		};
	}

	await db.put({
		TableName: 'hakataarchive-sessions',
		Item: {
			id: body.id,
			session: body.session,
		},
	}).promise();

	return {
		statusCode: 200,
		body: 'ok',
	};
};
