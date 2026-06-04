import React, { useState } from "react";
import AppLayout from "@/components/app-layout";
import CanvasPanel from "@/components/canvas-panel";

export interface DetectedElement {
  name: string;
  type: "obstacle" | "plant" | "structure" | "path" | "water" | "other";
  description: string;
}

export default function MainApp() {
  const [image, setImage] = useState<string | null>(null);

  return (
    <AppLayout imageBase64={image}>
      <CanvasPanel image={image} setImage={setImage} />
    </AppLayout>
  );
}
