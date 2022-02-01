import type {Object} from 'aws-sdk/clients/s3';
import sizeOf from 'image-size';
import {s3} from '../lib/aws';

(async () => {
	const images: Object[] = [];
	let isTruncated = true;
	let continuationToken = null;
	while (isTruncated) {
		console.log(`Retrieving image list (continuationToken = ${continuationToken})`);
		const data = await s3.listObjectsV2({
			Bucket: 'hakataarchive',
			...(continuationToken ? {ContinuationToken: continuationToken} : {}),
		}).promise();
		isTruncated = data.IsTruncated;

		images.push(...(data.Contents || []));
		if (data.NextContinuationToken) {
			continuationToken = data.NextContinuationToken;
		}
	}

	for (const image of images) {
		if (image.Key.startsWith('index/')) {
			continue;
		}

		try {
			console.log(`Processing image ${image.Key}`);
			const imageData = await s3.getObject({
				Bucket: 'hakataarchive',
				Key: image.Key,
			}).promise();

			const dimensions = sizeOf(imageData.Body as Buffer);
			await s3.copyObject({
				Bucket: 'hakataarchive',
				CopySource: `/hakataarchive/${image.Key}`,
				Key: image.Key,
				MetadataDirective: 'REPLACE',
				Metadata: {
					width: dimensions.width.toString(),
					hieght: dimensions.height.toString(),
				},
			}).promise();
		} catch (error) {
			console.error(error);
			console.error(`Failed to update image dimension for ${image.Key}`);
		}
	}
})();
