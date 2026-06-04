import React, { useRef, useState, useEffect } from "react";
import { Camera as CameraIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

interface CameraCaptureProps {
  onCapture: (base64Img: string) => void;
  onCancel: () => void;
}

export default function CameraCapture({ onCapture, onCancel }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    let activeStream: MediaStream | null = null;

    async function setupCamera() {
      try {
        const mediaStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
        activeStream = mediaStream;
        setStream(mediaStream);
        if (videoRef.current) {
          videoRef.current.srcObject = mediaStream;
        }
      } catch (err) {
        console.error("Error accessing camera:", err);
        setError("No se pudo acceder a la cámara");
        toast({
          title: "Error de cámara",
          description: "Asegúrate de haber otorgado permisos de cámara al navegador.",
          variant: "destructive",
        });
      }
    }

    setupCamera();

    return () => {
      if (activeStream) {
        activeStream.getTracks().forEach((track) => track.stop());
      }
    };
  }, [toast]);

  const handleCapture = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d");
      if (context) {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
        onCapture(dataUrl);
      }
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-black text-white relative h-full">
      {error ? (
        <div className="flex-1 flex items-center justify-center flex-col p-6 text-center">
          <CameraIcon className="w-12 h-12 mb-4 text-red-500 opacity-80" />
          <p className="text-xl font-medium mb-2">{error}</p>
          <Button variant="secondary" onClick={onCancel} className="mt-6">
            Volver
          </Button>
        </div>
      ) : (
        <>
          <div className="flex-1 relative overflow-hidden bg-black flex items-center justify-center">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="absolute inset-0 w-full h-full object-cover"
            />
            <canvas ref={canvasRef} className="hidden" />
          </div>
          
          <div className="absolute bottom-0 left-0 right-0 p-6 flex items-center justify-between bg-gradient-to-t from-black/80 to-transparent pt-20">
            <Button
              variant="ghost"
              size="icon"
              className="text-white hover:bg-white/20 rounded-full w-12 h-12"
              onClick={onCancel}
            >
              <X className="w-6 h-6" />
            </Button>
            
            <button
              onClick={handleCapture}
              className="w-20 h-20 rounded-full border-4 border-white/50 flex items-center justify-center focus:outline-none focus:ring-4 focus:ring-white/30 transition-all hover:border-white"
            >
              <div className="w-16 h-16 bg-white rounded-full transition-transform active:scale-90" />
            </button>
            
            <div className="w-12 h-12"></div> {/* Spacer for alignment */}
          </div>
        </>
      )}
    </div>
  );
}
