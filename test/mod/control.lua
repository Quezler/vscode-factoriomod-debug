local rcall = remote.call
remote.add_interface("debugadapter-tests",{
	error = function (mesg)
		return error(mesg, -1)
	end,
	perror = function (mesg)
		return pcall(error,mesg, -1)
	end,
	call = function(...)
		return rcall(...)
	end
})


local test_meta_a = {

}
script.register_metatable("test_a", test_meta_a)

function Test_A(t)
	return setmetatable(t,test_meta_a)
end

---@generic K,V
---@param lct LuaCustomTable<K,V>
---@return V
local function firstof(lct)
	for key, value in pairs(lct) do
		return value
	end
end

function Make_Test_Storage()
	local a = Test_A({id=1})
	local b = {[{true}]=a}
	storage.test = {
		a,a,{},{[b]=b,[{1}]={2},[{}]={},},
		1,2,3,true,false,"foo",
		game.player,
		game.player.character,
		game.player.cursor_stack,
		game.player.force,
		game.player.surface,
		game.player.gui,
		game.permissions,
		helpers.create_profiler(true),
		game.player.surface.get_tile(0,0),
		firstof(game.player.force.recipes),
		firstof(game.player.force.technologies),
		firstof(game.permissions.groups),
		firstof(prototypes.achievement),
		firstof(prototypes.ammo_category),
		firstof(prototypes.autoplace_control),
		firstof(prototypes.custom_input),
		firstof(prototypes.custom_event),
		firstof(prototypes.decorative),
		firstof(prototypes.damage),
		firstof(prototypes.entity),
		firstof(prototypes.equipment_category),
		firstof(prototypes.equipment_grid),
		firstof(prototypes.equipment),
		firstof(prototypes.fluid),
		firstof(prototypes.font),
		firstof(prototypes.fuel_category),
		firstof(prototypes.item_group),
		firstof(prototypes.item_subgroup),
		firstof(prototypes.item),
		firstof(prototypes.mod_setting),
		firstof(prototypes.module_category),
		firstof(prototypes.named_noise_expression),
		firstof(prototypes.named_noise_function),
		firstof(prototypes.particle),
		firstof(prototypes.recipe_category),
		firstof(prototypes.recipe),
		firstof(prototypes.resource_category),
		firstof(prototypes.shortcut),
		firstof(prototypes.technology),
		firstof(prototypes.tile),
		firstof(prototypes.trivial_smoke),
		firstof(prototypes.virtual_signal),
	}
end