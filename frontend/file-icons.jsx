import { FileIcon, defaultStyles } from 'react-file-icon';
import { Folder, FolderOpen } from 'lucide-react';

const families = [
  ['7z 7zip bz bz2 bzip2 gz gzip lz lz4 lzma rar tar tgz tbz tbz2 txz xz z zst zip zipx', 'compressed', '#9470c5'],
  ['avif bmp gif heic heif ico jpeg jpg png psd raw svg tif tiff webp', 'image', '#d58a55'],
  ['aac aif aiff alac flac m4a mid midi mp3 oga ogg opus wav wma', 'audio', '#bd70ad'],
  ['3g2 3gp asf avi flv m4v mkv mov mp4 mpeg mpg ogv rm ts vob webm wmv', 'video', '#a378cc'],
  ['doc docx fodt odt pages rtf wpd wps', 'document', '#5683c1'],
  ['csv fods numbers ods tsv xlr xls xlsb xlsm xlsx', 'spreadsheet', '#568e75'],
  ['fodp key odp potx pps ppsx ppt pptm pptx', 'presentation', '#cc8060'],
  ['c cc cpp cs css cxx dart go h hpp htm html java js jsx kt kts less lua m php pl py r rb rs sass scala scss sh bash zsh svelte swift ts tsx vue xml yaml yml toml json jsonc ini conf cfg env sql ipynb', 'code', '#668ca7'],
  ['txt text log md markdown rst tex epub mobi azw azw3', 'document', '#8a91a0'],
  ['pt pth onnx safetensors ckpt h5 hdf5 pkl pickle npy npz tflite gguf', 'binary', '#8976c7'],
  ['db db3 sqlite sqlite3 bin dat dll exe msi dmg pkg iso img deb rpm appimage wasm', 'binary', '#7c869b'],
  ['eot fnt fon otf ttf woff woff2', 'font', '#a98660'],
  ['3dm 3ds blend dwg dxf fbx glb gltf max obj skp stl usd usdz', '3d', '#77989b'],
];
const types = new Map(families.flatMap(([extensions, type, color]) => extensions.split(' ').map(extension => [extension, { type, labelColor: color }])));

export function FileTypeIcon({ name, isDir = false }) {
  if (isDir) return <><Folder className="folder-icon-closed" size={26} strokeWidth={1.6} /><FolderOpen className="folder-icon-open" size={26} strokeWidth={1.6} /></>;
  const lower = name.toLowerCase(), dot = lower.lastIndexOf('.');
  const extension = dot > 0 && dot < lower.length - 1 ? lower.slice(dot + 1) : '';
  const config = /^\.(env(?:\..*)?|gitignore|gitattributes|npmrc|editorconfig|dockerignore)$/.test(lower) || /^(dockerfile|makefile|cargo\.lock|package-lock\.json)$/.test(lower);
  const style = config ? { type:'code', labelColor:'#778b72' } : { ...types.get(extension), ...(Object.hasOwn(defaultStyles, extension) ? defaultStyles[extension] : {}) };
  const label = extension ? extension.slice(0, 5) : config ? 'CFG' : 'FILE';
  return <FileIcon extension={label} color="#e9ebef" labelColor="#7c869b" glyphColor={style.labelColor || '#7c869b'} labelUppercase gradientOpacity={.15} {...style} />;
}
