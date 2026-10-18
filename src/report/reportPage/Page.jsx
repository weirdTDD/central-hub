import ProductivityReport from '../components/ProductivityReport'
import Sidebar from '../components/Sidebar';


const ReportPage = () => {
  return (
    <div className="bg-gray-50 min-h-screen">
      <Sidebar currentPath="/reports" />

      {/* Main content */}
      <main className="p-0 md:p-8 md:ml-62">
        <div className="max-w-7xl md:mx-auto mx-0">
          <ProductivityReport />
          
        </div>
      </main>
    </div>
  );
};

export default ReportPage;
