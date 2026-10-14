// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A small JSON value with a parser and a writer, enough for the requests and replies of sx_brep.cpp.
#pragma once
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace sxj {

constexpr size_t kMaxOperationBytes = 128;
constexpr size_t kMaxRequestBytes = 32 * 1024 * 1024;
constexpr size_t kMaxJsonDepth = 64;
constexpr size_t kMaxJsonValues = 1'000'000;

struct Value {
    enum Kind { Null, Bool, Number, String, Array, Object } kind = Null;
    bool b = false;
    double n = 0;
    std::string s;
    std::vector<Value> a;
    std::map<std::string, Value> o;

    Value() = default;
    Value(double v) : kind(Number), n(v) {}
    Value(int v) : kind(Number), n(v) {}
    Value(long v) : kind(Number), n(double(v)) {}
    Value(unsigned long v) : kind(Number), n(double(v)) {}
    Value(unsigned long long v) : kind(Number), n(double(v)) {}
    Value(bool v) : kind(Bool), b(v) {}
    Value(const char* v) : kind(String), s(v) {}
    Value(std::string v) : kind(String), s(std::move(v)) {}
    static Value array() { Value v; v.kind = Array; return v; }
    static Value object() { Value v; v.kind = Object; return v; }

    bool has(const std::string& k) const { return kind == Object && o.count(k) && o.at(k).kind != Null; }
    const Value& operator[](const std::string& k) const
    {
        static const Value none;
        if (kind != Object) return none;
        auto it = o.find(k);
        return it == o.end() ? none : it->second;
    }
    Value& set(const std::string& k, Value v)
    {
        kind = Object;
        return o[k] = std::move(v);
    }
    void push(Value v)
    {
        kind = Array;
        a.push_back(std::move(v));
    }
};

// errors carry the field they are about, so a reply can name it
struct Error : std::runtime_error {
    std::string field;
    Error(std::string f, const std::string& m) : std::runtime_error(m), field(std::move(f)) {}
};

class Parser {
public:
    explicit Parser(const std::string& t) : t_(t) {}
    Value parse()
    {
        if (t_.size() > kMaxRequestBytes) throw Error("request", "exceeds 32 MiB");
        Value v = value();
        ws();
        if (i_ != t_.size()) fail("trailing text");
        return v;
    }

private:
    const std::string& t_;
    size_t i_ = 0;
    size_t values_ = 0;

    [[noreturn]] void fail(const char* m) { throw Error("request", std::string("bad JSON: ") + m); }
    void ws()
    {
        while (i_ < t_.size() && (t_[i_] == ' ' || t_[i_] == '\n' || t_[i_] == '\r' || t_[i_] == '\t')) ++i_;
    }
    bool eat(char c)
    {
        ws();
        if (i_ < t_.size() && t_[i_] == c) {
            ++i_;
            return true;
        }
        return false;
    }
    void expect(char c)
    {
        if (!eat(c)) fail("unexpected character");
    }
    Value value(size_t depth = 0)
    {
        if (++values_ > kMaxJsonValues) throw Error("request", "JSON exceeds 1000000 values");
        ws();
        if (i_ >= t_.size()) fail("unexpected end");
        char c = t_[i_];
        if ((c == '{' || c == '[') && depth >= kMaxJsonDepth)
            throw Error("request", "JSON nesting exceeds 64 containers");
        if (c == '{') {
            ++i_;
            Value v = Value::object();
            if (eat('}')) return v;
            do {
                ws();
                std::string k = str();
                expect(':');
                v.o[k] = value(depth + 1);
            } while (eat(','));
            expect('}');
            return v;
        }
        if (c == '[') {
            ++i_;
            Value v = Value::array();
            if (eat(']')) return v;
            do v.a.push_back(value(depth + 1));
            while (eat(','));
            expect(']');
            return v;
        }
        if (c == '"') return Value(str());
        if (t_.compare(i_, 4, "true") == 0) { i_ += 4; return Value(true); }
        if (t_.compare(i_, 5, "false") == 0) { i_ += 5; return Value(false); }
        if (t_.compare(i_, 4, "null") == 0) { i_ += 4; return Value(); }
        const char* start = t_.c_str() + i_;
        char* end = nullptr;
        double d = std::strtod(start, &end);
        if (end == start) fail("unexpected character");
        i_ += size_t(end - start);
        return Value(d);
    }
    std::string str()
    {
        if (i_ >= t_.size() || t_[i_] != '"') fail("expected a string");
        ++i_;
        std::string out;
        while (i_ < t_.size() && t_[i_] != '"') {
            char c = t_[i_++];
            if (c != '\\') {
                out += c;
                continue;
            }
            if (i_ >= t_.size()) fail("unexpected end");
            char e = t_[i_++];
            switch (e) {
            case 'n': out += '\n'; break;
            case 't': out += '\t'; break;
            case 'r': out += '\r'; break;
            case 'b': out += '\b'; break;
            case 'f': out += '\f'; break;
            case 'u': {
                if (i_ + 4 > t_.size()) fail("bad escape");
                unsigned cp = unsigned(std::strtoul(t_.substr(i_, 4).c_str(), nullptr, 16));
                i_ += 4;
                // names and labels only; anything past the basic plane is kept as a replacement
                if (cp < 0x80) out += char(cp);
                else if (cp < 0x800) { out += char(0xC0 | (cp >> 6)); out += char(0x80 | (cp & 0x3F)); }
                else { out += char(0xE0 | (cp >> 12)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
                break;
            }
            default: out += e;
            }
        }
        if (i_ >= t_.size()) fail("unterminated string");
        ++i_;
        return out;
    }
};

inline void write(const Value& v, std::string& out)
{
    switch (v.kind) {
    case Value::Null: out += "null"; break;
    case Value::Bool: out += v.b ? "true" : "false"; break;
    case Value::Number: {
        if (!std::isfinite(v.n)) { out += "null"; break; }
        char buf[32];
        if (v.n == std::floor(v.n) && std::fabs(v.n) < 1e15) std::snprintf(buf, sizeof buf, "%.0f", v.n);
        else std::snprintf(buf, sizeof buf, "%.17g", v.n);
        out += buf;
        break;
    }
    case Value::String:
        out += '"';
        for (char c : v.s) {
            if (c == '"' || c == '\\') { out += '\\'; out += c; }
            else if (c == '\n') out += "\\n";
            else if (static_cast<unsigned char>(c) < 0x20) { char buf[8]; std::snprintf(buf, sizeof buf, "\\u%04x", c); out += buf; }
            else out += c;
        }
        out += '"';
        break;
    case Value::Array: {
        out += '[';
        bool first = true;
        for (const auto& e : v.a) {
            if (!first) out += ',';
            first = false;
            write(e, out);
        }
        out += ']';
        break;
    }
    case Value::Object: {
        out += '{';
        bool first = true;
        for (const auto& kv : v.o) {
            if (!first) out += ',';
            first = false;
            write(Value(kv.first), out);
            out += ':';
            write(kv.second, out);
        }
        out += '}';
        break;
    }
    }
}

inline std::string dump(const Value& v)
{
    std::string out;
    write(v, out);
    return out;
}

} // namespace sxj
