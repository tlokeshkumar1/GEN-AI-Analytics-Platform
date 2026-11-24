import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))


def main():
    from api.embeddings.embedding_loader import embedding_loader

    sample_texts = [
        "North America region achieved $5.42M in revenue with cosmetics taking the top share.",
        "Europe regional sales expanded 12% year over year in Q3 driven by German office supplies.",
        "Asia Pacific beverage demand increased 18% online via Japan and Australia sales channels.",
    ]
    print(f"Generating embeddings for {len(sample_texts)} text chunks...")
    embedding_loader.load_texts(sample_texts, id_prefix="batch_script")
    print("Vector embedding generation complete.")


if __name__ == "__main__":
    main()
