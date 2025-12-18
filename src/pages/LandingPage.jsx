import { Link } from 'react-router-dom';
import { Monitor, Pencil } from 'phosphor-react';

export default function LandingPage() {
  const tvs = ['tv1', 'tv2', 'tv3', 'tv4'];

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8 font-sans">
      <div className="max-w-4xl mx-auto">
        <header className="mb-12 text-center">
          <h1 className="text-4xl font-bold mb-4 bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
            Shop TV System
          </h1>
          <p className="text-gray-400">Select a display to view or manage content.</p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12">
          {tvs.map((tv, index) => (
            <Link
              key={tv}
              to={`/${tv}`}
              className="group bg-gray-800 p-6 rounded-xl shadow-lg border border-gray-700 hover:border-blue-500 transition-all hover:shadow-blue-500/20 flex items-center justify-between"
            >
              <div className="flex items-center gap-4">
                <div className="p-3 bg-gray-700 rounded-lg group-hover:bg-blue-600 transition-colors">
                  <Monitor size={32} weight="duotone" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold capitalize">TV Display {index + 1}</h2>
                  <span className="text-sm text-gray-500 group-hover:text-gray-300">View Slideshow</span>
                </div>
              </div>
            </Link>
          ))}
        </div>

        <div className="flex justify-center">
          <a
            href="/admin/"
            className="flex items-center gap-2 px-6 py-3 bg-gray-800 hover:bg-gray-700 rounded-full border border-gray-600 transition-colors text-gray-300 hover:text-white"
          >
            <Pencil size={20} />
            <span>Open Content Manager (CMS)</span>
          </a>
        </div>
      </div>
    </div>
  );
}
