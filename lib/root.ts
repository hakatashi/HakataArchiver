
// eslint-disable-next-line no-unused-vars
import type {APIGatewayProxyHandler} from 'aws-lambda';
import 'source-map-support/register.js';
import {s3} from './aws';
import {verifyRequest} from './util';

export const getImages: APIGatewayProxyHandler = async (event) => {
	const error = verifyRequest(event);

	if (error !== null) {
		return error;
	}

	const imageKeys = event.multiValueQueryStringParameters?.image ?? [];

	const mediaContents = await Promise.all(imageKeys.map(async (imageKey) => {
		const head = await s3.headObject({
			Bucket: 'hakataarchive',
			Key: imageKey,
		}).promise();
		return {
			...head,
			key: imageKey,
		};
	}));

	const images = mediaContents.map((item) => {
		const url = s3.getSignedUrl('getObject', {
			Bucket: 'hakataarchive',
			Key: item.key,
		});
		return {
			src: url,
			w: parseInt(item.Metadata.width),
			h: parseInt(item.Metadata.height),
		};
	});

	return {
		statusCode: 200,
		headers: {
			'Content-Type': 'application/json',
			Vary: 'Origin',
			'Access-Control-Allow-Origin': origin,
		},
		body: JSON.stringify({
			images,
		}),
	};
};
