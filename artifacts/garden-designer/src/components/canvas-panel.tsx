import React, { useState } from "react";
import { Camera, Image as ImageIcon, Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import CameraCapture from "@/components/camera-capture";
import type { DetectedElement } from "@/pages/main";

const TYPE_LABELS: Record<DetectedElement["type"], string> = {
  obstacle: "Obstáculo",
  plant: "Planta",
  structure: "Estructura",
  path: "Camino",
  water: "Agua",
  other: "Otro",
};

const TYPE_COLORS: Record<DetectedElement["type"], string> = {
  obstacle: "bg-red-100 text-red-700 border-red-200",
  plant: "bg-green-100 text-green-700 border-green-200",
  structure: "bg-amber-100 text-amber-700 border-amber-200",
  path: "bg-blue-100 text-blue-700 border-blue-200",
  water: "bg-cyan-100 text-cyan-700 border-cyan-200",
  other: "bg-stone-100 text-stone-600 border-stone-200",
};

const TYPE_DOT: Record<DetectedElement["type"], string> = {
  obstacle: "bg-red-500",
  plant: "bg-green-500",
  structure: "bg-amber-500",
  path: "bg-blue-500",
  water: "bg-cyan-500",
  other: "bg-stone-400",
};

interface CanvasPanelProps {
  image: string | null;
  setImage: (img: string | null) => void;
  detectedElements?: DetectedElement[];
  isDetecting?: boolean;
}

export default function CanvasPanel({
  image,
  setImage,
  detectedElements = [],
  isDetecting = false,
}: CanvasPanelProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [cameraMode, setCameraMode] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const { toast } = useToast();

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      if (typeof event.target?.result === "string") {
        setImage(event.target.result);
        setModalOpen(false);
      }
    };
    reader.onerror = () => {
      toast({
        title: "Error",
        description: "No se pudo leer la imagen.",
        variant: "destructive",
      });
    };
    reader.readAsDataURL(file);
  };

  const handleCapture = (base64Img: string) => {
    setImage(base64Img);
    setCameraMode(false);
    setModalOpen(false);
  };

  const showDetection = image && (isDetecting || detectedElements.length > 0);

  return (
    <div className="flex-1 flex flex-col items-center justify-center relative bg-stone-100/50 min-h-[40vh] md:min-h-full p-4 overflow-hidden border-b md:border-b-0 md:border-r border-border">
      {image ? (
        <div className="relative w-full h-full flex flex-col items-center justify-center">
          <img
            src={image}
            alt="Jardín escaneado"
            className="max-w-full max-h-[80vh] md:max-h-full object-contain rounded-xl shadow-lg"
          />

          {showDetection && (
            <div className="absolute bottom-16 left-4 right-4 md:left-6 md:right-auto md:max-w-sm bg-white/95 backdrop-blur border border-border rounded-2xl shadow-lg overflow-hidden">
              <button
                onClick={() => setPanelOpen((v) => !v)}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-stone-50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  {isDetecting ? (
                    <Loader2 className="w-4 h-4 animate-spin text-primary" />
                  ) : (
                    <span className="w-4 h-4 flex items-center justify-center">
                      <span className="w-2 h-2 rounded-full bg-primary" />
                    </span>
                  )}
                  <span className="text-sm font-semibold text-foreground">
                    {isDetecting
                      ? "Detectando elementos..."
                      : `${detectedElements.length} elemento${detectedElements.length !== 1 ? "s" : ""} detectado${detectedElements.length !== 1 ? "s" : ""}`}
                  </span>
                </div>
                {!isDetecting &&
                  detectedElements.length > 0 &&
                  (panelOpen ? (
                    <ChevronDown className="w-4 h-4 text-muted-foreground" />
                  ) : (
                    <ChevronUp className="w-4 h-4 text-muted-foreground" />
                  ))}
              </button>

              {!isDetecting && panelOpen && detectedElements.length > 0 && (
                <div className="px-4 pb-4 max-h-52 overflow-y-auto space-y-2">
                  {detectedElements.map((el, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${TYPE_DOT[el.type]}`} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-foreground truncate">
                            {el.name}
                          </span>
                          <span
                            className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${TYPE_COLORS[el.type]}`}
                          >
                            {TYPE_LABELS[el.type]}
                          </span>
                        </div>
                        {el.description && (
                          <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
                            {el.description}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {isDetecting && (
                <div className="px-4 pb-4 space-y-2">
                  {[1, 2, 3].map((n) => (
                    <div key={n} className="flex items-center gap-2 animate-pulse">
                      <span className="w-2 h-2 rounded-full bg-stone-200" />
                      <div className="h-3 bg-stone-200 rounded flex-1" style={{ width: `${60 + n * 10}%` }} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <Button
            variant="secondary"
            className="absolute bottom-4 right-4 shadow-md bg-white/90 backdrop-blur"
            onClick={() => setModalOpen(true)}
          >
            <Camera className="w-4 h-4 mr-2" />
            Escanear de nuevo
          </Button>
        </div>
      ) : (
        <div className="text-center max-w-md mx-auto space-y-6">
          <div className="w-24 h-24 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
            <Camera className="w-10 h-10 text-primary" />
          </div>
          <h2 className="text-2xl font-semibold text-foreground">Tu lienzo de jardín</h2>
          <p className="text-muted-foreground text-lg">
            Toma una foto de tu espacio al aire libre para comenzar a diseñar con la asistencia de la IA.
          </p>
          <Button
            size="lg"
            className="w-full text-lg h-14 rounded-xl shadow-md"
            onClick={() => setModalOpen(true)}
          >
            Escanear jardín
          </Button>
        </div>
      )}

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-md rounded-2xl overflow-hidden p-0 border-0 bg-background shadow-xl">
          {cameraMode ? (
            <div className="relative w-full bg-black flex flex-col h-[80vh] md:h-[600px]">
              <CameraCapture onCapture={handleCapture} onCancel={() => setCameraMode(false)} />
            </div>
          ) : (
            <div className="p-6">
              <DialogHeader className="mb-6">
                <DialogTitle className="text-2xl font-semibold">Añadir imagen</DialogTitle>
              </DialogHeader>
              <div className="grid grid-cols-1 gap-4">
                <Button
                  size="lg"
                  className="h-20 text-lg flex items-center justify-start px-6 bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl"
                  onClick={() => setCameraMode(true)}
                >
                  <Camera className="w-6 h-6 mr-4" />
                  Tomar foto con la cámara
                </Button>
                <div className="relative">
                  <input
                    type="file"
                    accept="image/*"
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                    onChange={handleFileUpload}
                  />
                  <Button
                    size="lg"
                    variant="outline"
                    className="w-full h-20 text-lg flex items-center justify-start px-6 rounded-xl bg-white hover:bg-stone-50"
                  >
                    <ImageIcon className="w-6 h-6 mr-4 text-primary" />
                    Subir desde la galería
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
