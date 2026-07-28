type ItemCardProps = {
  name: string;
  location: string;
  date: string;
};

export default function ItemCard({
  name,
  location,
  date,
}: ItemCardProps) {
  return (
    <div
      style={{
        border: "1px solid #ddd",
        padding: "15px",
        marginTop: "15px",
        borderRadius: "8px",
      }}
    >
      <h3>{name}</h3>

      <p>📍 {location}</p>

      <p>📅 {date}</p>
    </div>
  );
}