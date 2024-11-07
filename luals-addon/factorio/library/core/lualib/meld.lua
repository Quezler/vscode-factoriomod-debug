---@meta

---@class meld
---@field private control_marker meld.control_marker
---@field private control_handlers meld.control_handlers
---@overload fun(target:table, source:table):table
local meld = {}

---@class (exact) meld.control_marker
meld.control_marker = {} -- empty but unique table used as a marker

---@class meld.control_handlers
meld.control_handlers = {}

---@class (exact) meld.control_op
---@field marker meld.control_marker

---@class (exact) meld.delete_op : meld.control_op
---@field op "delete"

---@return meld.delete_op
meld.delete = function() end

meld.control_handlers.delete = function(target, k, v)
  target[k] = nil
end

---@class (exact) meld.overwrite_op : meld.control_op
---@field op "overwrite"
---@field data any

---@return meld.overwrite_op
meld.overwrite = function(new) end

meld.control_handlers.overwrite = function(target, k, v)
  target[k] = util.copy(v.data)
end

---@class (exact) meld.invoke_op : meld.control_op
---@field op "invoke"
---@field fct fun(v:any):any

---@return meld.invoke_op
meld.invoke = function(fct) end

meld.control_handlers.invoke = function(target, k, v)
  target[k] = v.fct(target[k])
end

---@class (exact) meld.append_op : meld.control_op
---@field op "append"
---@field data any[]

---@return meld.append_op
meld.append = function(data) end
meld.control_handlers.append = function(target, k, v)
  for _, to_append in pairs(v.data) do
    table.insert(target[k], util.copy(to_append))
  end
end

--- recursive table merge but it reuses target table (does not deepcopy it). When target is not to be reused or more than
---  2 tables are to be merged, consider using util.merge. When there is conflict of 2 values, a value from the source will
---  win overwriting the existing value. There are also control structures available for extra operations that would not
---  be possible under normal merge rules
---@generic T
---@param target T
---@param source table
---@return T
meld.meld = function(target, source) end

return meld