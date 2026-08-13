import pandas
import os

path = os.path.join(os.path.dirname(__file__), "verbs-dictionaries.csv")
verbs = pandas.read_csv(
    path,
    names=[
        "infinitive",
        "present",
        "past_simple",
        "past_participle",
        "present_participle",
    ],
    sep="\t",
)

past_tense = verbs["past_simple"].tolist()
past_participle = verbs["past_participle"].tolist()

from tqdm import tqdm

with open("past_tense_verbs.txt", "w") as f:
    for verb in tqdm(sorted(set(past_tense))):
        f.write(f"dogs {verb} banks on the river\n")

with open("past_participle_verbs.txt", "w") as f:
    for verb in tqdm(sorted(set(past_participle))):
        f.write(f"dogs had {verb} banks on the river\n")
