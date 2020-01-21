import {DynamoDB, S3} from 'aws-sdk';

export const db = new DynamoDB.DocumentClient({convertEmptyValues: true});
export const s3 = new S3();
