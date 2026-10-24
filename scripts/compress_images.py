import os
from PIL import Image

# Path to your Catan images directory
INPUT_DIR = r"C:\Users\rahmanma\OneDrive - Intel Corporation\Documents\1_docs\gamesutils\static\images\catanbk\t"
#OUTPUT_DIR = r"C:\Users\rahmanma\OneDrive - Intel Corporation\Documents\1_docs\gamesutils\static\catan\images_optimized"
OUTPUT_DIR = INPUT_DIR
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Target maximum dimensions
MAX_WIDTH = 200
MAX_HEIGHT = 200

for filename in os.listdir(INPUT_DIR):
    if filename.lower().endswith(('.png', '.jpg', '.jpeg')):
        filepath = os.path.join(INPUT_DIR, filename)
        name, _ = os.path.splitext(filename)
        output_path = os.path.join(OUTPUT_DIR, f"{name}.webp")

        with Image.open(filepath) as img:
            # Resize proportionally if larger than maximum dimension
            img.thumbnail((MAX_WIDTH, MAX_HEIGHT), Image.Resampling.LANCZOS)
            
            # Save as optimized WebP with transparency support
            img.save(output_path, "WEBP", quality=82, method=6)
            
            original_size = os.path.getsize(filepath) / 1024
            new_size = os.path.getsize(output_path) / 1024
            print(f"Compressed {filename}: {original_size:.1f} KB -> {new_size:.1f} KB (Saved {100 - (new_size/original_size*100):.1f}%)")

print("\nDone! All images optimized to WebP.")
