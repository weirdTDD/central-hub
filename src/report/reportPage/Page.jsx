import ProductivityReport from "../components/ProductivityReport";
import AppShell from "../../components/AppShell";

const ReportPage = () => {
  return (
    <AppShell currentPath="/reports">
      <ProductivityReport />
    </AppShell>
  );
};

export default ReportPage;
