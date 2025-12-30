import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ASSETS_DIR = path.resolve(__dirname, '../public/assets');
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1080;

async function resizeImages() {
    if (!fs.existsSync(ASSETS_DIR)) {
        console.error(`Assets directory not found: ${ASSETS_DIR}`);
        return;
    }

    const files = fs.readdirSync(ASSETS_DIR);
    const imageFiles = files.filter(file => /\.(jpg|jpeg|png|webp)$/i.test(file));

    console.log(`Found ${imageFiles.length} images in ${ASSETS_DIR}`);

    for (const file of imageFiles) {
        const filePath = path.join(ASSETS_DIR, file);
        try {
            const image = sharp(filePath);
            const metadata = await image.metadata();

            // Compression settings
            if (metadata.format === 'jpeg' || metadata.format === 'jpg') {
                image.jpeg({ quality: 80, mozjpeg: true });
            } else if (metadata.format === 'png') {
                image.png({ compressionLevel: 9, palette: true });
            } else if (metadata.format === 'webp') {
                image.webp({ quality: 80 });
            }

            // Create a temporary file
            const tempPath = filePath + '.tmp';

            // Always attempt resize + compress
            await image
                .resize({
                    width: MAX_WIDTH,
                    height: MAX_HEIGHT,
                    fit: 'inside', // Maintain aspect ratio, do not crop
                    withoutEnlargement: true
                })
                .toFile(tempPath);

            const originalStats = fs.statSync(filePath);
            const newStats = fs.statSync(tempPath);

            // Replace only if smaller
            if (newStats.size < originalStats.size) {
                fs.renameSync(tempPath, filePath);
                const saved = ((originalStats.size - newStats.size) / 1024).toFixed(2);
                console.log(`✅ Optimized ${file}: Saved ${saved}KB`);
            } else {
                fs.unlinkSync(tempPath);
                console.log(`Skipping ${file} (No improvement)`);
            }
        } catch (error) {
            console.error(`❌ Failed to process ${file}:`, error);
        }
    }
}

resizeImages();
