import { useState } from "react";

// Per docs/FLUTTER_CLIENT_SPEC.md Section 4: station logoUrl and event
// imageUrl are both optional - loaded with an explicit placeholder/
// error-fallback (the subject's own initial-letter avatar), never a
// broken-image icon. This is that fallback, shared by station and event
// cards alike.
export function MediaAvatar({ src, label, className }: { src: string | null; label: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const initial = label.trim().charAt(0).toUpperCase() || "?";

  if (!src || failed) {
    return (
      <div
        className={`flex items-center justify-center bg-ocean-100 text-ocean-700 font-semibold ${className ?? ""}`}
        aria-hidden="true"
      >
        {initial}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt=""
      className={`object-cover ${className ?? ""}`}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
