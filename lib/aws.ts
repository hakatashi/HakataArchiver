import {DynamoDB, S3, CloudWatch} from 'aws-sdk';

export const db = new DynamoDB.DocumentClient({convertEmptyValues: true});
export const s3 = new S3();
const cloudwatch = new CloudWatch();

export const incrementCounter = (name: string, delta: number = 1) => (
	cloudwatch.putMetricData({
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
	}).promise()
);
