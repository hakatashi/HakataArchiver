from PIL import Image
from pathlib import Path
import pyarrow as pa
from tagger import get_raw_tags

schema = pa.schema([
	pa.field('key', pa.string(), metadata={'description': 'Relative path to image file.'}),
	pa.field('tag_probs', pa.list_(pa.float32()), metadata={'description': 'List of probabilities for each tag. The index of each probability corresponds to the index of the tag in the https://github.com/RF5/danbooru-pretrained/raw/master/config/class_names_6000.json file.'}),
])

base_dir = Path('Z:\\hakataarchive')
images_dir = base_dir / 'pixiv'

Image.MAX_IMAGE_PIXELS = None

print(f'Listing all images in {images_dir}...')

with pa.OSFile('pixiv_tags.arrow', 'wb') as sink:
	with pa.ipc.new_file(sink, schema) as writer:
		for image_file in images_dir.iterdir():
			key = image_file.relative_to(base_dir).as_posix()
			print(f'Processing {key}...')

			if any(filter(key.endswith, ['.mp4', '.zip', '.psd', '.mp3', '.avi', '.clip', '.pdf', '.wav'])):
				continue

			try:
				input_image = Image.open(image_file)
			except Exception as e:
				print('Image open failed')
				print(e)
				continue

			print('Loaded image (format = {}, size = {}, mode = {})'.format(input_image.format, input_image.size, input_image.mode))
			image_format = input_image.format
			width, height = input_image.size

			try:
				if input_image.mode != 'RGB':
					input_image = input_image.convert('RGB')
			except Exception as e:
				print('Image conversion failed')
				print(e)
				continue

			print('Tagging image...')

			try:
				tags_obj = get_raw_tags(input_image)
			except Exception as e:
				print('Image tagging failed')
				print(e)
				continue

			writer.write_batch(pa.RecordBatch.from_arrays([
				pa.array([key]),
				pa.array([tags_obj.numpy()]),
			], schema=schema))
