// One-off geocoding script. Queries Nominatim (1 req/sec) and builds cities.json.
import { readFile, writeFile } from 'node:fs/promises';

const SOURCE = 'Poland: Main Jewish Communities, Death Camps and Mass Murder Sites, 1939–1945';

// slug helper: strip diacritics -> kebab-case ascii
function slug(s) {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l').replace(/Ł/g, 'l')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Each: name (display, historical Polish), type, query (modern+country for geocoding),
// optional fallback, optional fixed [lat,lng] to skip API.
const L = [
  // --- Camps ---
  { name: 'Chełmno', type: 'camp', query: 'Chełmno nad Nerem, Poland', fallback: 'Chelmno extermination camp' },
  { name: 'Łęczyca', type: 'camp', query: 'Łęczyca, Poland' },
  // --- Northern Poland ---
  { name: 'Gdynia', type: 'community', query: 'Gdynia, Poland' },
  { name: 'Gdańsk', type: 'community', query: 'Gdańsk, Poland' },
  { name: 'Starogard', type: 'community', query: 'Starogard Gdański, Poland' },
  { name: 'Grudziądz', type: 'community', query: 'Grudziądz, Poland' },
  { name: 'Bydgoszcz', type: 'community', query: 'Bydgoszcz, Poland' },
  { name: 'Toruń', type: 'community', query: 'Toruń, Poland' },
  { name: 'Czarnków', type: 'community', query: 'Czarnków, Poland' },
  { name: 'Inowrocław', type: 'community', query: 'Inowrocław, Poland' },
  { name: 'Aleksandrów', type: 'community', query: 'Aleksandrów Kujawski, Poland' },
  { name: 'Włocławek', type: 'community', query: 'Włocławek, Poland' },
  { name: 'Gniezno', type: 'community', query: 'Gniezno, Poland' },
  { name: 'Płock', type: 'community', query: 'Płock, Poland' },
  { name: 'Płońsk', type: 'community', query: 'Płońsk, Poland' },
  { name: 'Mława', type: 'community', query: 'Mława, Poland' },
  { name: 'Łomża', type: 'community', query: 'Łomża, Poland' },
  { name: 'Ostrołęka', type: 'community', query: 'Ostrołęka, Poland' },
  { name: 'Ciechanów', type: 'community', query: 'Ciechanów, Poland' },
  { name: 'Suwałki', type: 'community', query: 'Suwałki, Poland' },
  { name: 'Augustów', type: 'community', query: 'Augustów, Poland' },
  { name: 'Sokółka', type: 'community', query: 'Sokółka, Poland' },
  { name: 'Bielsk Podlaski', type: 'community', query: 'Bielsk Podlaski, Poland' },
  { name: 'Bereza Kartuska', type: 'community', query: 'Byaroza, Belarus', fallback: 'Bereza, Belarus' },
  { name: 'Byteń', type: 'community', query: 'Byten, Belarus' },

  // --- Central Poland ---
  { name: 'Kutno', type: 'community', query: 'Kutno, Poland' },
  { name: 'Łowicz', type: 'community', query: 'Łowicz, Poland' },
  { name: 'Skierniewice', type: 'community', query: 'Skierniewice, Poland' },
  { name: 'Góra Kalwaria', type: 'community', query: 'Góra Kalwaria, Poland' },
  { name: 'Mińsk Mazowiecki', type: 'community', query: 'Mińsk Mazowiecki, Poland' },
  { name: 'Węgrów', type: 'community', query: 'Węgrów, Poland' },
  { name: 'Siedlce', type: 'community', query: 'Siedlce, Poland' },
  { name: 'Siemiatycze', type: 'community', query: 'Siemiatycze, Poland' },
  { name: 'Biała Podlaska', type: 'community', fixed: [52.0338, 23.1202] },
  { name: 'Brześć', type: 'community', query: 'Brest, Belarus', fallback: 'Brest-Litovsk' },
  { name: 'Międzyrzec Podlaski', type: 'community', query: 'Międzyrzec Podlaski, Poland' },
  { name: 'Łuków', type: 'community', query: 'Łuków, Poland' },
  { name: 'Zduńska Wola', type: 'community', query: 'Zduńska Wola, Poland' },
  { name: 'Pabianice', type: 'community', query: 'Pabianice, Poland' },
  { name: 'Piotrków Trybunalski', type: 'community', query: 'Piotrków Trybunalski, Poland' },
  { name: 'Tomaszów Mazowiecki', type: 'community', query: 'Tomaszów Mazowiecki, Poland' },
  { name: 'Radom', type: 'community', query: 'Radom, Poland' },
  { name: 'Lubartów', type: 'community', query: 'Lubartów, Poland' },
  { name: 'Chełm', type: 'community', query: 'Chełm, Poland' },
  { name: 'Włodawa', type: 'community', query: 'Włodawa, Poland' },
  { name: 'Kamień Koszyrski', type: 'community', query: 'Kamin-Kashyrskyi, Ukraine' },

  // --- Eastern Poland (now Belarus) ---
  { name: 'Grodno', type: 'community', query: 'Grodno, Belarus' },
  { name: 'Indura', type: 'community', query: 'Indura, Belarus' },
  { name: 'Wołkowysk', type: 'community', query: 'Vawkavysk, Belarus' },
  { name: 'Baranowicze', type: 'community', query: 'Baranavichy, Belarus' },
  { name: 'Słonim', type: 'community', query: 'Slonim, Belarus' },
  { name: 'Nowogródek', type: 'community', query: 'Navahrudak, Belarus' },
  { name: 'Zdzięcioł', type: 'community', query: 'Dzyatlava, Belarus' },
  { name: 'Lida', type: 'community', query: 'Lida, Belarus' },
  { name: 'Ejszyszki', type: 'community', query: 'Eišiškės, Lithuania' },
  { name: 'Iwje', type: 'community', query: 'Iuye, Belarus', fallback: 'Ivye, Belarus' },
  { name: 'Wołożyn', type: 'community', query: 'Valozhyn, Belarus' },
  { name: 'Raków', type: 'community', query: 'Rakaw, Belarus', fallback: 'Rakov, Belarus' },
  { name: 'Smorgonie', type: 'community', query: 'Smarhon, Belarus' },
  { name: 'Mołodeczno', type: 'community', query: 'Maladzyechna, Belarus' },
  { name: 'Wilejka', type: 'community', query: 'Vileyka, Belarus' },
  { name: 'Podbrodzie', type: 'community', query: 'Pabradė, Lithuania' },
  { name: 'Święciany', type: 'community', query: 'Švenčionys, Lithuania' },
  { name: 'Brasław', type: 'community', query: 'Braslaw, Belarus' },
  { name: 'Głębokie', type: 'community', query: 'Hlybokaye, Belarus' },
  { name: 'Kobryń', type: 'community', query: 'Kobryn, Belarus' },
  { name: 'Janów Poleski', type: 'community', query: 'Ivanava, Brest Region, Belarus', fallback: 'Janow Poleski' },
  { name: 'Pińsk', type: 'community', query: 'Pinsk, Belarus' },
  { name: 'Łuniniec', type: 'community', query: 'Luninets, Belarus' },
  { name: 'Stolin', type: 'community', query: 'Stolin, Belarus' },
  { name: 'Dąbrowica', type: 'community', query: 'Dubrovytsia, Ukraine' },
  { name: 'Sarny', type: 'community', query: 'Sarny, Ukraine' },
  { name: 'Stępań', type: 'community', query: 'Stepan, Rivne Oblast, Ukraine' },
  { name: 'Kowel', type: 'community', query: 'Kovel, Ukraine' },
  { name: 'Włodzimierz Wołyński', type: 'community', query: 'Volodymyr, Ukraine', fallback: 'Volodymyr-Volynskyi' },
  { name: 'Łuck', type: 'community', query: 'Lutsk, Ukraine' },
  { name: 'Równe', type: 'community', query: 'Rivne, Ukraine' },
  { name: 'Korzec', type: 'community', query: 'Korets, Ukraine' },

  // --- Western Poland ---
  { name: 'Poznań', type: 'community', query: 'Poznań, Poland' },
  { name: 'Leszno', type: 'community', query: 'Leszno, Poland' },
  { name: 'Grodzisk Wielkopolski', type: 'community', query: 'Grodzisk Wielkopolski, Poland' },
  { name: 'Krotoszyn', type: 'community', query: 'Krotoszyn, Poland' },
  { name: 'Kalisz', type: 'community', query: 'Kalisz, Poland' },

  // --- Southern Poland ---
  { name: 'Kielce', type: 'community', query: 'Kielce, Poland' },
  { name: 'Częstochowa', type: 'community', query: 'Częstochowa, Poland' },
  { name: 'Zawiercie', type: 'community', query: 'Zawiercie, Poland' },
  { name: 'Sosnowiec', type: 'community', query: 'Sosnowiec, Poland' },
  { name: 'Katowice', type: 'community', query: 'Katowice, Poland' },
  { name: 'Bielsko-Biała', type: 'community', query: 'Bielsko-Biała, Poland' },
  { name: 'Limanowa', type: 'community', query: 'Limanowa, Poland' },
  { name: 'Nowy Sącz', type: 'community', query: 'Nowy Sącz, Poland' },
  { name: 'Tarnów', type: 'community', query: 'Tarnów, Poland' },
  { name: 'Dębica', type: 'community', query: 'Dębica, Poland' },
  { name: 'Rzeszów', type: 'community', query: 'Rzeszów, Poland' },
  { name: 'Jasło', type: 'community', query: 'Jasło, Poland' },
  { name: 'Sanok', type: 'community', query: 'Sanok, Poland' },
  { name: 'Przemyśl', type: 'community', query: 'Przemyśl, Poland' },
  { name: 'Jarosław', type: 'community', query: 'Jarosław, Poland' },
  { name: 'Radomsko', type: 'community', query: 'Radomsko, Poland' },
  { name: 'Końskie', type: 'community', query: 'Końskie, Poland' },
  { name: 'Ostrowiec', type: 'community', query: 'Ostrowiec Świętokrzyski, Poland' },
  { name: 'Opatów', type: 'community', query: 'Opatów, Poland' },
  { name: 'Sandomierz', type: 'community', query: 'Sandomierz, Poland' },
  { name: 'Biłgoraj', type: 'community', fixed: [50.5410, 22.7220] },
  { name: 'Pińczów', type: 'community', query: 'Pińczów, Poland' },
  { name: 'Tarnobrzeg', type: 'community', query: 'Tarnobrzeg, Poland' },
  { name: 'Miechów', type: 'community', query: 'Miechów, Poland' },
  { name: 'Mielec', type: 'community', query: 'Mielec, Poland' },
  { name: 'Kolbuszowa', type: 'community', query: 'Kolbuszowa, Poland' },
  { name: 'Kraśnik', type: 'community', query: 'Kraśnik, Poland' },
  { name: 'Zamość', type: 'community', query: 'Zamość, Poland' },

  // --- Eastern Galicia (now Ukraine) ---
  { name: 'Dubno', type: 'community', query: 'Dubno, Ukraine' },
  { name: 'Krzemieniec', type: 'community', query: 'Kremenets, Ukraine' },
  { name: 'Brody', type: 'community', fixed: [50.0831, 25.1476] },
  { name: 'Złoczów', type: 'community', query: 'Zolochiv, Lviv Oblast, Ukraine' },
  { name: 'Zbaraż', type: 'community', query: 'Zbarazh, Ukraine' },
  { name: 'Tarnopol', type: 'community', query: 'Ternopil, Ukraine' },
  { name: 'Rohatyn', type: 'community', query: 'Rohatyn, Ukraine' },
  { name: 'Skalat', type: 'community', query: 'Skalat, Ukraine' },
  { name: 'Brzezany', type: 'community', fixed: [49.449, 24.944] },
  { name: 'Drohobycz', type: 'community', query: 'Drohobych, Ukraine' },
  { name: 'Stryj', type: 'community', query: 'Stryi, Ukraine' },
  { name: 'Turka', type: 'community', query: 'Turka, Lviv Oblast, Ukraine' },
  { name: 'Skole', type: 'community', query: 'Skole, Ukraine' },
  { name: 'Stanisławów', type: 'community', query: 'Ivano-Frankivsk, Ukraine' },
  { name: 'Tłumacz', type: 'community', query: 'Tlumach, Ukraine' },
  { name: 'Tłuste', type: 'community', query: 'Tovste, Ternopil Oblast, Ukraine' },
  { name: 'Skała', type: 'community', query: 'Skala-Podilska, Ukraine' },
  { name: 'Buczacz', type: 'community', fixed: [49.0833, 25.4000] },
  { name: 'Czortków', type: 'community', query: 'Chortkiv, Ukraine' },
  { name: 'Kołomyja', type: 'community', query: 'Kolomyia, Ukraine' },
  { name: 'Śniatyn', type: 'community', query: 'Sniatyn, Ukraine' },
  { name: 'Rawa Ruska', type: 'community', query: 'Rava-Ruska, Ukraine' },
  { name: 'Bełz', type: 'community', fixed: [50.3826, 24.0066] },
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function geocode(q) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`;
  const res = await fetch(url, { headers: { 'User-Agent': 'poland-what-happened-here/1.0 (jackanthonywarren@gmail.com)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.length) return null;
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
}

const out = [];
const failures = [];

for (const item of L) {
  let coord = null;
  if (item.fixed) {
    coord = { lat: item.fixed[0], lng: item.fixed[1] };
    console.log(`FIXED  ${item.name} -> ${coord.lat}, ${coord.lng}`);
  } else {
    try {
      coord = await geocode(item.query);
      await sleep(1100);
      if (!coord && item.fallback) {
        coord = await geocode(item.fallback);
        await sleep(1100);
      }
    } catch (e) {
      console.log(`ERROR  ${item.name}: ${e.message}`);
      await sleep(1100);
    }
    if (coord) console.log(`OK     ${item.name} -> ${coord.lat}, ${coord.lng}`);
    else { console.log(`FAIL   ${item.name} (${item.query})`); failures.push(item.name); }
  }

  out.push({
    id: slug(item.name),
    name: item.name,
    hebrew: '',
    lat: coord ? Math.round(coord.lat * 10000) / 10000 : null,
    lng: coord ? Math.round(coord.lng * 10000) / 10000 : null,
    type: item.type,
    summary: '',
    source: SOURCE,
    source_url: '',
  });
}

const existing = JSON.parse(await readFile(new URL('../data/cities.json', import.meta.url)));
const combined = [...existing, ...out];

await writeFile(new URL('../data/cities.json', import.meta.url), JSON.stringify(combined, null, 2) + '\n');

console.log(`\nDone. Existing: ${existing.length}, new: ${out.length}, total: ${combined.length}`);
if (failures.length) console.log(`FAILURES (${failures.length}): ${failures.join(', ')}`);
