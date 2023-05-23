import torch
from torchvision import transforms
import json
import urllib, urllib.request

with urllib.request.urlopen("https://github.com/RF5/danbooru-pretrained/raw/master/config/class_names_6000.json") as url:
    class_names = json.loads(url.read().decode())

model = torch.hub.load('RF5/danbooru-pretrained', 'resnet50')
model.eval()
model = model.to('cuda')

preprocess = transforms.Compose([
    transforms.Resize(360),
    transforms.ToTensor(),
    transforms.Normalize(mean=[0.7137, 0.6628, 0.6519], std=[0.2970, 0.3017, 0.2979]),
])

def get_tags(input_image, threshold = 0.1):
    input_tensor = preprocess(input_image)
    input_batch = input_tensor.unsqueeze(0)
    input_batch = input_batch.to('cuda')

    with torch.no_grad():
        output = model(input_batch)

    probs = torch.sigmoid(output[0]).cpu()

    tmp = probs[probs > threshold]
    inds = probs.argsort(descending=True)
    tag_dict = {}
    for i in inds[0:len(tmp)]:
        tag_dict[class_names[i]] = probs[i].numpy()[()].item()

    return tag_dict
