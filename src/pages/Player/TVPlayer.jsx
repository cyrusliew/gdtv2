import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';

// Import all JSON files from the data directory
const tvDataModules = import.meta.glob('../../data/tv*.json', { eager: true });

export default function TVPlayer() {
    const { tvId } = useParams();
    const [slides, setSlides] = useState([]);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const videoRef = useRef(null);
    const timeoutRef = useRef(null);

    useEffect(() => {
        setIsLoading(true);
        // Construct the path to the specific JSON file
        const path = `../../data/${tvId}.json`;
        const module = tvDataModules[path];

        if (module && module.slides) {
            setSlides(module.slides);
        } else {
            console.warn(`No configuration found for ${tvId}`);
            setSlides([]);
            setIsLoading(false);
        }

        // Reset index when TV changes
        setCurrentIndex(0);
    }, [tvId]);

    // Preload images
    useEffect(() => {
        if (slides.length === 0) return;

        let isMounted = true;

        const preloadImages = async () => {
            const imagePromises = slides
                .filter((slide) => slide.type === 'image')
                .map((slide) => {
                    return new Promise((resolve) => {
                        const img = new Image();
                        img.src = slide.src;
                        img.onload = resolve;
                        img.onerror = resolve; // Proceed even if fails
                    });
                });

            await Promise.all(imagePromises);

            if (isMounted) {
                setIsLoading(false);
            }
        };

        preloadImages();

        return () => {
            isMounted = false;
        };
    }, [slides]);

    // Check for updates
    useEffect(() => {
        let initialVersion = null;

        const checkVersion = async () => {
            try {
                const response = await fetch('/version.json');
                const data = await response.json();

                if (!initialVersion) {
                    initialVersion = data.timestamp;
                } else if (data.timestamp !== initialVersion) {
                    console.log('New version detected, reloading...');
                    window.location.reload();
                }
            } catch (error) {
                console.error('Failed to check version:', error);
            }
        };

        // Initial check
        checkVersion();

        // Poll every 30 seconds
        const intervalId = setInterval(checkVersion, 30000);

        return () => clearInterval(intervalId);
    }, []);

    // Handle slide transition logic
    useEffect(() => {
        if (isLoading || slides.length === 0) return;

        const currentSlide = slides[currentIndex];

        // Clear any existing timeout
        if (timeoutRef.current) clearTimeout(timeoutRef.current);

        const advanceSlide = () => {
            setCurrentIndex((prev) => (prev + 1) % slides.length);
        };

        if (currentSlide.type === 'image') {
            const duration = (currentSlide.duration || 10) * 1000;
            timeoutRef.current = setTimeout(advanceSlide, duration);
        } else if (currentSlide.type === 'video') {
            // Video handled by onEnded
        }

        return () => {
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
        };
    }, [currentIndex, slides, isLoading]);

    const handleVideoEnded = () => {
        setCurrentIndex((prev) => (prev + 1) % slides.length);
    };

    if (isLoading) {
        return (
            <div className="bg-black h-screen w-screen flex items-center justify-center">
                <div className="animate-spin rounded-full h-32 w-32 border-t-2 border-b-2 border-white"></div>
            </div>
        );
    }

    if (slides.length === 0) return <div className="bg-black text-white h-screen flex items-center justify-center text-2xl">No content scheduled</div>;

    const currentSlide = slides[currentIndex];

    return (
        <div className="bg-black h-screen w-screen overflow-hidden flex items-center justify-center">
            {currentSlide.type === 'image' ? (
                <img
                    key={currentSlide.id + '-img'}
                    src={currentSlide.src}
                    alt="slide"
                    className="w-full h-full object-contain"
                />
            ) : (
                <video
                    key={currentSlide.id + '-vid'}
                    ref={videoRef}
                    src={currentSlide.src}
                    className="w-full h-full object-contain"
                    autoPlay
                    muted
                    playsInline
                    onEnded={handleVideoEnded}
                />
            )}
        </div>
    );
}
