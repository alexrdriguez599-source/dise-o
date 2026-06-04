import React from "react";

type Bg = "light" | "dark";

interface HabitaLogoProps {
  /** Background the logo sits on. "light" = beige/white surfaces, "dark" = dark surfaces. */
  bg?: Bg;
  /** Wordmark font-size in px (everything else scales from this). */
  size?: number;
  /** Draw the single-line house frame behind the wordmark (signature). Off by default. */
  withHouse?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Atria — elegant wordmark. Cormorant serif with wide tracking; the first "A"
 * is restyled as an architectural arch/atrium (gold threshold + keystone),
 * framed by a single continuous line house outline for a premium signature.
 * NOTE: file/component name kept (`HabitaLogo`) intentionally — internal id, not user-visible.
 */
export default function HabitaLogo({
  bg = "light",
  size = 28,
  withHouse = false,
  className,
  style,
}: HabitaLogoProps) {
  const ink = bg === "dark" ? "#f4efe4" : "#16352a";
  const gold = "#c8a96a";
  const houseOpacity = bg === "dark" ? 0.4 : 0.5;

  return (
    <span
      className={className}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "flex-end",
        justifyContent: "center",
        fontFamily: "'Cormorant Garamond', Georgia, serif",
        fontWeight: 600,
        fontSize: size,
        lineHeight: 1,
        color: ink,
        padding: withHouse ? "0.52em 0.82em 0.24em" : 0,
        ...style,
      }}
    >
      {withHouse && (
        <svg
          viewBox="0 0 390 112"
          preserveAspectRatio="none"
          aria-hidden="true"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", zIndex: 0 }}
        >
          <path
            d="M18 104 L18 52 L150 20 L240 20 L372 52 L372 104 Z"
            fill="none"
            stroke={ink}
            strokeWidth={2.4}
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={houseOpacity}
          />
          <path d="M150 20 L240 20" fill="none" stroke={gold} strokeWidth={3} strokeLinecap="round" />
        </svg>
      )}

      <span
        style={{
          position: "relative",
          zIndex: 1,
          display: "inline-flex",
          alignItems: "flex-end",
          letterSpacing: "0.16em",
        }}
      >
        {/* arch "A" — atrium */}
        <svg
          viewBox="0 0 92 112"
          aria-hidden="true"
          style={{ height: "0.92em", width: "0.6em", marginRight: "0.12em", overflow: "visible" }}
        >
          <path
            d="M14 104 L40 34 Q46 20 52 34 L78 104"
            fill="none"
            stroke={ink}
            strokeWidth={7}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M30 80 L62 80" fill="none" stroke={gold} strokeWidth={6} strokeLinecap="round" />
          <circle cx="46" cy="26" r="2.4" fill={gold} />
        </svg>
        <span>TRIA</span>
      </span>
    </span>
  );
}
