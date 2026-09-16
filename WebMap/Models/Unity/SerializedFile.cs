using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace WebMap.Models.Unity
{
    // A Unity serialized file (the CAB-… inside a bundle, or a *.assets file): header,
    // type trees, object table, and a type-tree driven reader for Texture2D objects.
    internal sealed class SerializedFile
    {
        public sealed class TypeNode { public int Level; public string Type; public string Name; public int Size; public int Meta; }
        public sealed class TypeInfo { public int ClassId; public TypeNode[] Nodes; }
        public sealed class ObjectInfo { public long PathId; public long Start; public int Size; public int TypeIndex; }
        public sealed class Texture2D
        {
            public string Name; public int Width, Height, Format, MipCount; public int ImageDataSize;
            public byte[] ImageData; public string StreamPath; public long StreamOffset; public int StreamSize;
        }

        public readonly List<TypeInfo> Types = new List<TypeInfo>();
        public readonly List<ObjectInfo> Objects = new List<ObjectInfo>();
        public uint Version; public string UnityVersion = "";
        private readonly byte[] data;

        private const string COMMON = "AABB\0AnimationClip\0AnimationCurve\0AnimationState\0Array\0Base\0BitField\0bitset\0bool\0char\0ColorRGBA\0Component\0data\0deque\0double\0dynamic_array\0FastPropertyName\0first\0float\0Font\0GameObject\0Generic Mono\0GradientNEW\0GUID\0GUIStyle\0int\0list\0long long\0map\0Matrix4x4f\0MdFour\0MonoBehaviour\0MonoScript\0m_ByteSize\0m_Curve\0m_EditorClassIdentifier\0m_EditorHideFlags\0m_Enabled\0m_ExtensionPtr\0m_GameObject\0m_Index\0m_IsArray\0m_IsStatic\0m_MetaFlag\0m_Name\0m_ObjectHideFlags\0m_PrefabInternal\0m_PrefabParentObject\0m_Script\0m_StaticEditorFlags\0m_Type\0m_Version\0Object\0pair\0PPtr<Component>\0PPtr<GameObject>\0PPtr<Material>\0PPtr<MonoBehaviour>\0PPtr<MonoScript>\0PPtr<Object>\0PPtr<Prefab>\0PPtr<Sprite>\0PPtr<TextAsset>\0PPtr<Texture>\0PPtr<Texture2D>\0PPtr<Transform>\0Prefab\0Quaternionf\0Rectf\0RectInt\0RectOffset\0second\0set\0short\0size\0SInt16\0SInt32\0SInt64\0SInt8\0staticvector\0string\0TextAsset\0TextMesh\0Texture\0Texture2D\0Transform\0TypelessData\0UInt16\0UInt32\0UInt64\0UInt8\0unsigned int\0unsigned long long\0unsigned short\0vector\0Vector2f\0Vector3f\0Vector4f\0m_ScriptingClassIdentifier\0Gradient\0Type*\0int2_storage\0int3_storage\0BoundsInt\0m_CorrespondingSourceObject\0m_PrefabInstance\0m_PrefabAsset\0FileSize\0Hash128\0RenderingLayerMask\0";

        public static bool Looks(byte[] d)
        {
            // metadata size / file size / version / data offset, big-endian; version 5..30 is plausible
            if (d == null || d.Length < 48) return false;
            uint ver = (uint)((d[8] << 24) | (d[9] << 16) | (d[10] << 8) | d[11]);
            return ver >= 5 && ver <= 40;
        }

        public SerializedFile(byte[] bytes)
        {
            data = bytes;
            uint metaSize = BE32(0), fileSize = BE32(4); Version = BE32(8); long dataOffset = BE32(12);
            int p = 16;
            int endian = data[p]; p += 4;
            if (Version >= 22)
            {
                metaSize = BE32(p); p += 4;
                fileSize = (uint)BE64(p); p += 8;
                dataOffset = BE64(p); p += 8;
                p += 8;
            }
            if (endian != 0) throw new NotSupportedException("big-endian serialized file");
            var r = new LeReader(data, p);
            UnityVersion = r.CString(); r.I32(); bool typeTree = r.U8() != 0;
            int ntypes = r.I32();
            for (int i = 0; i < ntypes; i++)
            {
                var t = new TypeInfo { ClassId = r.I32() };
                r.U8(); r.I16();
                if (t.ClassId == 114) r.Skip(16);
                r.Skip(16);
                if (typeTree)
                {
                    int nn = r.I32(), sbs = r.I32();
                    var nodes = new TypeNode[nn];
                    var typeOff = new int[nn]; var nameOff = new int[nn];
                    for (int j = 0; j < nn; j++)
                    {
                        r.U16(); var n = new TypeNode { Level = r.U8() }; r.U8();
                        typeOff[j] = (int)r.U32(); nameOff[j] = (int)r.U32();
                        n.Size = r.I32(); r.I32(); n.Meta = r.I32();
                        if (Version >= 19) r.Skip(8);
                        nodes[j] = n;
                    }
                    int sb = r.Pos; r.Skip(sbs);
                    for (int j = 0; j < nn; j++) { nodes[j].Type = TtString(sb, typeOff[j]); nodes[j].Name = TtString(sb, nameOff[j]); }
                    t.Nodes = nodes;
                    if (Version >= 21) { int nd = r.I32(); r.Skip(4 * nd); }
                }
                Types.Add(t);
            }
            int nobj = r.I32();
            for (int i = 0; i < nobj; i++)
            {
                r.Align(4);
                var o = new ObjectInfo { PathId = r.I64() };
                o.Start = dataOffset + (Version >= 22 ? r.I64() : r.U32());
                o.Size = (int)r.U32(); o.TypeIndex = r.I32();
                Objects.Add(o);
            }
        }

        private uint BE32(int p) => (uint)((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]);
        private long BE64(int p) => ((long)BE32(p) << 32) | BE32(p + 4);

        private string TtString(int bufStart, int off)
        {
            if ((off & 0x80000000) != 0)
            {
                off &= 0x7fffffff;
                if (off >= COMMON.Length) return "?";
                int e = COMMON.IndexOf('\0', off); return COMMON.Substring(off, e - off);
            }
            int s = bufStart + off, i = s;
            while (i < data.Length && data[i] != 0) i++;
            return Encoding.UTF8.GetString(data, s, i - s);
        }

        public int ClassOf(ObjectInfo o) => o.TypeIndex >= 0 && o.TypeIndex < Types.Count ? Types[o.TypeIndex].ClassId : -1;

        // Reads a Texture2D object through its type tree; null when the file has no type tree.
        public Texture2D ReadTexture2D(ObjectInfo o)
        {
            var t = Types[o.TypeIndex];
            if (t.Nodes == null) return null;
            var r = new LeReader(data, (int)o.Start);
            var tex = new Texture2D();
            int idx = 1;   // children of the root
            var nodes = t.Nodes;
            while (idx < nodes.Length)
            {
                var n = nodes[idx];
                int end = Subtree(nodes, idx);
                switch (n.Name)
                {
                    case "m_Name": tex.Name = ReadString(r); break;
                    case "m_Width": tex.Width = r.I32(); break;
                    case "m_Height": tex.Height = r.I32(); break;
                    case "m_TextureFormat": tex.Format = r.I32(); break;
                    case "m_MipCount": tex.MipCount = r.I32(); break;
                    case "image data": { int len = r.I32(); tex.ImageDataSize = len; tex.ImageData = r.Bytes(len); break; }
                    case "m_StreamData":
                    {
                        // offset (u64 or u32), size u32, path string -- in tree order
                        int k = idx + 1;
                        while (k < end)
                        {
                            var c = nodes[k]; int cend = Subtree(nodes, k);
                            if (c.Name == "offset") tex.StreamOffset = c.Size == 8 ? r.I64() : r.U32();
                            else if (c.Name == "size") tex.StreamSize = (int)r.U32();
                            else if (c.Name == "path") tex.StreamPath = ReadString(r);
                            else SkipValue(r, nodes, k);
                            if ((c.Meta & 0x4000) != 0) r.Align(4);
                            k = cend;
                        }
                        break;
                    }
                    default: SkipValue(r, nodes, idx); break;
                }
                if ((n.Meta & 0x4000) != 0) r.Align(4);
                idx = end;
            }
            return tex;
        }

        // A Mesh object's fields, as the file stores them (vertex streams still packed).
        public sealed class MeshData
        {
            public string Name; public int VertexCount; public int IndexFormat; public int MeshCompression;
            public byte[] IndexBuffer; public byte[] VertexBytes;
            public List<Dictionary<string, object>> SubMeshes = new List<Dictionary<string, object>>();
            public List<Dictionary<string, object>> Channels = new List<Dictionary<string, object>>();
            public Dictionary<string, object> Compressed;
            public string StreamPath; public long StreamOffset; public int StreamSize;
        }

        // Reads a Mesh (class 43) through its type tree; null without a type tree.
        public MeshData ReadMesh(ObjectInfo o)
        {
            var t = Types[o.TypeIndex];
            if (t.Nodes == null) return null;
            var r = new LeReader(data, (int)o.Start);
            var d = ReadAny(r, t.Nodes, 0) as Dictionary<string, object>;
            if (d == null) return null;
            var m = new MeshData { Name = d.TryGetValue("m_Name", out object nm) ? nm as string : null };
            if (d.TryGetValue("m_SubMeshes", out object sm) && sm is List<object> sl) foreach (var x in sl) if (x is Dictionary<string, object> sd) m.SubMeshes.Add(sd);
            m.IndexFormat = AsInt(d, "m_IndexFormat");
            m.MeshCompression = AsInt(d, "m_MeshCompression");
            m.IndexBuffer = d.TryGetValue("m_IndexBuffer", out object ib) ? ib as byte[] : null;
            if (d.TryGetValue("m_VertexData", out object vdo) && vdo is Dictionary<string, object> vd)
            {
                m.VertexCount = AsInt(vd, "m_VertexCount");
                if (vd.TryGetValue("m_Channels", out object ch) && ch is List<object> cl) foreach (var x in cl) if (x is Dictionary<string, object> cd) m.Channels.Add(cd);
                m.VertexBytes = vd.TryGetValue("m_DataSize", out object ds) ? ds as byte[] : null;
            }
            if (d.TryGetValue("m_CompressedMesh", out object cm)) m.Compressed = cm as Dictionary<string, object>;
            if (d.TryGetValue("m_StreamData", out object sdo) && sdo is Dictionary<string, object> st)
            {
                m.StreamOffset = AsLong(st, "offset"); m.StreamSize = AsInt(st, "size");
                m.StreamPath = st.TryGetValue("path", out object sp) ? sp as string : null;
            }
            return m;
        }

        public static int AsInt(Dictionary<string, object> d, string k) => d != null && d.TryGetValue(k, out object v) ? (int)ToLong(v) : 0;
        public static long AsLong(Dictionary<string, object> d, string k) => d != null && d.TryGetValue(k, out object v) ? ToLong(v) : 0;
        public static float AsFloat(Dictionary<string, object> d, string k) => d != null && d.TryGetValue(k, out object v) ? (v is float f ? f : v is double db ? (float)db : ToLong(v)) : 0f;
        private static long ToLong(object v)
        {
            switch (v)
            {
                case int i: return i; case uint u: return u; case byte b: return b; case sbyte sb: return sb;
                case short sh: return sh; case ushort us: return us; case long l: return l; case ulong ul: return (long)ul;
                case bool bo: return bo ? 1 : 0; case float f: return (long)f; case double d: return (long)d;
                default: return 0;
            }
        }

        // Generic type-tree deserializer: compound -> Dictionary, array -> List (byte[] for byte arrays),
        // string -> string, leaf -> boxed primitive. Follows the same alignment rules as SkipValue.
        private static object ReadAny(LeReader r, TypeNode[] nodes, int i)
        {
            var n = nodes[i]; int end = Subtree(nodes, i);
            if (n.Type == "string") return ReadString(r);
            if (n.Type == "TypelessData") { int len = r.I32(); return r.Bytes(len); }
            if (end > i + 1 && nodes[i + 1].Type == "Array")
            {
                int len = r.I32(); int elem = i + 3; var arr = nodes[i + 1];
                object result;
                if (elem >= end || len < 0) result = new List<object>();
                else if (nodes[elem].Size == 1 && Subtree(nodes, elem) == end) result = r.Bytes(len);
                else
                {
                    var list = new List<object>(Math.Min(len, 1 << 16));
                    for (int k = 0; k < len; k++) { list.Add(ReadAny(r, nodes, elem)); if ((nodes[elem].Meta & 0x4000) != 0) r.Align(4); }
                    result = list;
                }
                if ((arr.Meta & 0x4000) != 0) r.Align(4);
                return result;
            }
            if (end == i + 1)
            {
                switch (n.Type)
                {
                    case "int": case "SInt32": return r.I32();
                    case "unsigned int": case "UInt32": return r.U32();
                    case "float": return r.F32();
                    case "double": { long bits = r.I64(); return BitConverter.Int64BitsToDouble(bits); }
                    case "bool": return r.U8() != 0;
                    case "UInt8": case "char": return r.U8();
                    case "SInt8": return (sbyte)r.U8();
                    case "SInt16": case "short": return r.I16();
                    case "UInt16": case "unsigned short": return r.U16();
                    case "SInt64": case "long long": return r.I64();
                    case "UInt64": case "unsigned long long": case "FileSize": return (ulong)r.I64();
                    default: r.Skip(n.Size > 0 ? n.Size : 0); return null;
                }
            }
            var dict = new Dictionary<string, object>();
            int c = i + 1;
            while (c < end) { dict[nodes[c].Name] = ReadAny(r, nodes, c); if ((nodes[c].Meta & 0x4000) != 0) r.Align(4); c = Subtree(nodes, c); }
            return dict;
        }

        private static int Subtree(TypeNode[] nodes, int i) { int j = i + 1; while (j < nodes.Length && nodes[j].Level > nodes[i].Level) j++; return j; }

        private static string ReadString(LeReader r) { int len = r.I32(); string s = Encoding.UTF8.GetString(r.Bytes(len)); r.Align(4); return s; }

        // Advances past node i's value without keeping it.
        private static void SkipValue(LeReader r, TypeNode[] nodes, int i)
        {
            var n = nodes[i]; int end = Subtree(nodes, i);
            if (n.Type == "string") { int len = r.I32(); r.Skip(len); r.Align(4); return; }
            if (n.Type == "TypelessData") { int len = r.I32(); r.Skip(len); return; }
            if (end > i + 1 && nodes[i + 1].Type == "Array")
            {
                int len = r.I32(); int elem = i + 3; var arr = nodes[i + 1];
                if (elem >= end) return;
                if (nodes[elem].Size > 0 && Subtree(nodes, elem) == end && nodes[elem].Type != "string") r.Skip(len * nodes[elem].Size);
                else for (int k = 0; k < len; k++) { SkipValue(r, nodes, elem); if ((nodes[elem].Meta & 0x4000) != 0) r.Align(4); }
                if ((arr.Meta & 0x4000) != 0) r.Align(4);
                return;
            }
            if (end == i + 1) { r.Skip(n.Size > 0 ? n.Size : 0); return; }
            int c = i + 1;
            while (c < end) { SkipValue(r, nodes, c); if ((nodes[c].Meta & 0x4000) != 0) r.Align(4); c = Subtree(nodes, c); }
        }
    }

    internal sealed class LeReader
    {
        private readonly byte[] b; public int Pos;
        public LeReader(byte[] b, int pos) { this.b = b; Pos = pos; }
        public byte U8() => b[Pos++];
        public short I16() { short v = (short)(b[Pos] | (b[Pos + 1] << 8)); Pos += 2; return v; }
        public ushort U16() { ushort v = (ushort)(b[Pos] | (b[Pos + 1] << 8)); Pos += 2; return v; }
        public int I32() { int v = b[Pos] | (b[Pos + 1] << 8) | (b[Pos + 2] << 16) | (b[Pos + 3] << 24); Pos += 4; return v; }
        public uint U32() => (uint)I32();
        public float F32() { float v = BitConverter.ToSingle(b, Pos); Pos += 4; return v; }
        public long I64() { long lo = U32(); long hi = U32(); return lo | (hi << 32); }
        public void Skip(int n) { Pos += n; }
        public void Align(int a) { Pos = (Pos + a - 1) / a * a; }
        public byte[] Bytes(int n) { var o = new byte[n]; Buffer.BlockCopy(b, Pos, o, 0, n); Pos += n; return o; }
        public string CString() { int s = Pos; while (b[Pos] != 0) Pos++; string v = Encoding.UTF8.GetString(b, s, Pos - s); Pos++; return v; }
    }
}
