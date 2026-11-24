import { redirect } from "next/navigation";

// Old prototype URL kept working.
export default function LostRedirect() {
  redirect("/items?type=lost");
}
