// Signed-out users don't see this control at all (rather than a disabled
// heart that does nothing when clicked) - favoriting is meaningless
// without an account to attach it to, and the auth-gated screens
// (Favorites, per RequireAuth) are the honest place to prompt sign-in.
export function FavoriteButton({
  isFavorited,
  onToggle,
  label,
}: {
  isFavorited: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
      aria-pressed={isFavorited}
      aria-label={isFavorited ? `Remove ${label} from favorites` : `Add ${label} to favorites`}
      className={`shrink-0 rounded-full p-2 text-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ocean-500 ${
        isFavorited ? "text-sunset-600 hover:text-sunset-500" : "text-ocean-300 hover:text-ocean-500"
      }`}
    >
      {isFavorited ? "♥" : "♡"}
    </button>
  );
}
