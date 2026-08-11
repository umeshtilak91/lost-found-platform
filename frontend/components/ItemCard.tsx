type ItemCardProps = {
  name: string;
  location: string;
  date: string;
  description?: string;
  image: string | null;
};

export default function ItemCard({
  name,
  location,
  date,
  description,
  image,
}: ItemCardProps) {
  const formattedDate = new Date(date).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  return (
    <div
      style={{
        border: "1px solid #444",
        borderRadius: "12px",
        overflow: "hidden",
        background: "#111",
        marginTop: "20px",
      }}
    >
      {image && (
        <img
          src={`http://localhost:5000/uploads/${image}`}
          alt={name}
          style={{
            width: "100%",
            height: "260px",
            objectFit: "contain",
            display: "block",
            background: "#222",
          }}
        />
      )}

      <div style={{ padding: "18px" }}>
        <h2 style={{ margin: "0 0 10px 0" }}>{name}</h2>

        <p style={{ margin: "8px 0" }}>
          📍 {location}
        </p>

        <p style={{ margin: "8px 0" }}>
          📅 {formattedDate}
        </p>

        {description && (
          <p style={{ margin: "12px 0 0 0", color: "#bbb" }}>
            📝 {description}
          </p>
        )}
      </div>
    </div>
  );
}