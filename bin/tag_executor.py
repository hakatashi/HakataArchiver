from PIL import Image
import firebase_admin
from firebase_admin import firestore
import boto3
import io
from tagger import get_tags

def normalize_key(key):
    return key.replace('/', '+')

app = firebase_admin.initialize_app()
db = firestore.client()
s3_client = boto3.client('s3')
s3 = boto3.resource('s3')

print('Loading all documents in collection "media":')

docs = db.collection('media').stream()
doc_ids = set()
for doc in docs:
    doc_ids.add(doc.id)

print('Loaded {} documents'.format(len(doc_ids)))

for media_object in s3.Bucket('hakataarchive').objects.all():
    normalized_key = normalize_key(media_object.key)
    if any(filter(normalized_key.endswith, ['.mp4', '.zip', '.psd', '.mp3', '.avi', '.clip', '.pdf', '.wav'])):
        continue
    if normalized_key in doc_ids:
        continue

    print('Downloading image from S3: {}'.format(media_object.key))

    s3_response_object = s3_client.get_object(Bucket='hakataarchive', Key=media_object.key)
    object_content = s3_response_object['Body'].read()

    try:
        input_image = Image.open(io.BytesIO(object_content))
    except Exception as e:
        print('Image open failed')
        print(e)
        continue

    print('Downloaded image from S3 (format = {}, size = {}, mode = {})'.format(input_image.format, input_image.size, input_image.mode))

    if input_image.mode != 'RGB':
        input_image = input_image.convert('RGB')

    print('Tagging image...')

    tags_obj = get_tags(input_image, threshold = 0.05)

    print('Uploading tags to Firestore...')

    db.collection('media').document(normalized_key).set({
        'danbooru_tags': tags_obj,
    }, merge=True)
