import { foundItems } from "../../data/foundItems";
import ItemCard from "../../components/ItemCard";

export default function FoundPage() {
  return (
    <main style={{ padding: "30px" }}>
      <h1>🎒 Found Items</h1>

      {foundItems.map((item) => (
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