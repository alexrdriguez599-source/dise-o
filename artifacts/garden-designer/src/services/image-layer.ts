/**
 * ImageLayer — Manages the base image for design.
 * ZERO AI dependency. Pure browser APIs.
 */
export class ImageLayer {
  /**
   * Load an image from a File object (camera capture or file picker).
   * Returns a data URL. No AI involved.
   */
  static fromFile(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target?.result as string);
      reader.onerror = () => reject(new Error("No se pudo leer el archivo"));
      reader.readAsDataURL(file);
    });
  }

  /**
   * Resize a data URL image to a maximum dimension, preserving aspect ratio.
   * No AI. Pure canvas.
   */
  static resize(dataURL: string, maxDim = 1920): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(maxDim / img.naturalWidth, maxDim / img.naturalHeight, 1);
        const w = Math.round(img.naturalWidth * scale);
        const h = Math.round(img.naturalHeight * scale);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d")!.drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/jpeg", 0.92));
      };
      img.onerror = () => reject(new Error("No se pudo cargar la imagen"));
      img.src = dataURL;
    });
  }

  /**
   * Draw an image into a canvas element, centered with object-contain behavior.
   * No AI.
   */
  static draw(canvas: HTMLCanvasElement, dataURL: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const ctx = canvas.getContext("2d")!;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const scale = Math.min(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
        const w = img.naturalWidth * scale;
        const h = img.naturalHeight * scale;
        const x = (canvas.width - w) / 2;
        const y = (canvas.height - h) / 2;
        ctx.drawImage(img, x, y, w, h);
        resolve();
      };
      img.onerror = () => reject(new Error("Error al dibujar imagen"));
      img.src = dataURL;
    });
  }

  /**
   * Composite a semi-transparent overlay canvas on top of an image.
   * Used to show flat material fills without AI.
   */
  static compositeOverlay(
    baseDataURL: string,
    overlayCanvas: HTMLCanvasElement
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const W = overlayCanvas.width;
        const H = overlayCanvas.height;
        const out = document.createElement("canvas");
        out.width = W; out.height = H;
        const ctx = out.getContext("2d")!;
        const scale = Math.min(W / img.naturalWidth, H / img.naturalHeight);
        const w = img.naturalWidth * scale;
        const h = img.naturalHeight * scale;
        const x = (W - w) / 2;
        const y = (H - h) / 2;
        ctx.drawImage(img, x, y, w, h);
        ctx.drawImage(overlayCanvas, 0, 0);
        resolve(out.toDataURL("image/jpeg", 0.92));
      };
      img.onerror = () => reject(new Error("Error al componer imagen"));
      img.src = baseDataURL;
    });
  }
}
