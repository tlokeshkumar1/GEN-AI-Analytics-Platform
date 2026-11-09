import sys
from pathlib import Path

backend_api_path = Path(__file__).resolve().parent.parent / "backend" / "api"
sys.path.append(str(backend_api_path))

from api.embeddings.embedding_loader import embedding_loader

def main():
    sample_texts = [
        "North America region achieved $5.42M in revenue with cosmetics taking the top share.",
        "Europe regional sales expanded 12% year over year in Q3 driven by German office supplies.",
        "Asia Pacific beverage demand increased 18% online via Japan and Australia sales channels."
    ]
    print(f"Generating embeddings for {len(sample_texts)} text chunks...")
    embedding_loader.load_texts(sample_texts, id_prefix="batch_script")
    print("Vector embedding generation complete.")

if __name__ == "__main__":
    main()
