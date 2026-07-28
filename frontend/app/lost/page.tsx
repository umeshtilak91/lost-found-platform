import { lostItems } from "../../data/lostItems";
import ItemCard from "../../components/ItemCard";

export default function LostPage() {
  return (
    <main style={{ padding: "30px" }}>
      <h1>🔍 Lost Items</h1>

      {lostItems.map((item) => (
        <ItemCard
          key={item.id}
          name={item.name}
          location={item.location}
          date={item.date}
        />
      ))}
    </main>
  );
}