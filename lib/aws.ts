import {DynamoDB, S3, CloudWatch} from 'aws-sdk';
import sizeOf from 'image-size';

export const db = new DynamoDB.DocumentClient({convertEmptyValues: true});
export const s3 = new S3();
const cloudwatch = new CloudWatch();

export const incrementCounter = (name: string, delta: number = 1) => {
	console.log(`[${name}] Incrementing counter by ${delta}`);

	return cloudwatch.putMetricData({
		Namespace: 'HakataArchiverMetrics',
		MetricData: [
			{
				MetricName: name,
				Dimensions: [
					{
						Name: 'Application',
						Value: 'HakataArchive',
					},
				],
				Timestamp: new Date(),
				Unit: 'Count',
				Value: delta,
			},
		],
	}).promise();
};

export const uploadImage = async (image: Buffer, filename: string) => {
	const dimension = sizeOf(image);
	console.log({dimension});

	const result = s3.upload({
		Bucket: 'hakataarchive',
		Key: filename,
		Body: image,
		StorageClass: 'GLACIER_IR',
		Metadata: {
			width: dimension.width.toString(),
			height: dimension.height.toString(),
		},
	});

	await result.promise();
};
