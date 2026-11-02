import { Redirect } from "../../../components/redirect.tsx";

// Moved under Status page; links and bookmarks to the old address still land.
export default function Moved() {
  return <Redirect to="/dashboard/status-page/subscribers/" />;
}
