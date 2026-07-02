import './globals.css';

export const metadata = {
  title: 'Job Hunt Dashboard – Pulkit Agarwal',
  description: '12LPA+ · India only · Go / Node / Full-Stack roles',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
