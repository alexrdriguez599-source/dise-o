import { useState, useEffect } from "react";

export type DeviceType = "mobile" | "tablet" | "desktop";

function detectDevice(): DeviceType {
  if (typeof window === "undefined") return "desktop";
  const isCoarse = window.matchMedia("(pointer: coarse)").matches;
  const w = window.innerWidth;
  if (!isCoarse) return "desktop";
  return w < 768 ? "mobile" : "tablet";
}

export function useDeviceType(): DeviceType {
  const [device, setDevice] = useState<DeviceType>(detectDevice);

  useEffect(() => {
    const detect = () => setDevice(detectDevice());
    window.addEventListener("resize", detect);
    const mql = window.matchMedia("(pointer: coarse)");
    mql.addEventListener("change", detect);
    return () => {
      window.removeEventListener("resize", detect);
      mql.removeEventListener("change", detect);
    };
  }, []);

  return device;
}

export function useOrientation(): "portrait" | "landscape" {
  const [orient, setOrient] = useState<"portrait" | "landscape">(() =>
    typeof window !== "undefined" && window.innerHeight > window.innerWidth
      ? "portrait"
      : "landscape",
  );

  useEffect(() => {
    const update = () => {
      setOrient(window.innerHeight > window.innerWidth ? "portrait" : "landscape");
    };
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  return orient;
}
