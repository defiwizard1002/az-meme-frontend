// Figma 22708:17371 and 22450:37011 supply the fixed flame/brain/microphone assets.
export function DesignIcon({
  name,
  filled = false,
}: {
  name: "flame" | "smart-money" | "kol" | "star" | "bolt";
  filled?: boolean;
}) {
  if (name === "star" || name === "bolt")
    return (
      <svg className={`design-icon icon-${name}`} viewBox="0 0 16 16" aria-hidden="true">
        {name === "star" ? (
          <path
            d="m8 1.5 1.95 4.15 4.55.6-3.3 3.2.85 4.55L8 11.8 3.95 14l.85-4.55-3.3-3.2 4.55-.6Z"
            fill={filled ? "#f5b532" : "none"}
            stroke={filled ? "#f5b532" : "currentColor"}
            strokeWidth="1"
          />
        ) : (
          <path d="M9.3 1 3.5 9h4l-.8 6 5.8-8h-4Z" fill="#f5d35b" />
        )}
      </svg>
    );
  return (
    <img
      className={`design-icon icon-${name}`}
      src={`/icons/${name}.svg`}
      alt=""
      aria-hidden="true"
    />
  );
}
