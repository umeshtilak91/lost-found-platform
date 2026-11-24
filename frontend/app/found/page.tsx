import { redirect } from "next/navigation";

// Old prototype URL kept working.
export default function FoundRedirect() {
  redirect("/items?type=found");
}
