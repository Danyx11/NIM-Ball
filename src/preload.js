// Shared image-preload helper — resolves on error too (a missing/broken
// asset shouldn't hang whatever loading gate is awaiting the batch forever).
export function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(img);
    img.src = src;
  });
}

export function loadImages(urls) {
  return Promise.all(urls.map(loadImage));
}
