from datasets import load_dataset, Dataset, ClassLabel
import pyarrow as pa

dataset = Dataset.from_file('all_tags.arrow')

print(dataset.shape)
print(dataset.features)

dataset_dict = dataset.train_test_split(test_size=0.4, seed=1337)

print(dataset_dict['train'].format)
print(dataset_dict['train'].features)

test_dataset_dict = dataset_dict['test'].train_test_split(test_size=0.5, seed=1337)

dataset_dict['test'] = test_dataset_dict['train']
dataset_dict['validation'] = test_dataset_dict['test']

dataset_dict = dataset_dict.cast_column('class', ClassLabel(num_classes=3, names=['not_bookmarked', 'bookmarked_public', 'bookmarked_private'], id=None))

print(dataset_dict.shape)
print(dataset_dict['train'].features)
print(dataset_dict.unique('class'))

dataset_dict.push_to_hub('hakatashi/hakatashi-pixiv-bookmark-deepdanbooru-private')

# NOTE: remove_columns is mutable method
public_dataset_dict = dataset_dict.remove_columns(['key'])

print(public_dataset_dict.shape)
print(public_dataset_dict['train'].features)
print(public_dataset_dict.unique('class'))

public_dataset_dict.push_to_hub('hakatashi/hakatashi-pixiv-bookmark-deepdanbooru')

